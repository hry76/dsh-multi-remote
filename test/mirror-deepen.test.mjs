/**
 * 「占位文件」与「后台补拉」的契约测试。
 *
 * ## 背景（2026-10-07 用户实测反馈）
 *
 * 界面的读文件路径是**宿主独占**的（`workspaceFiles` → 宿主的沙箱 fs），
 * 插件插不进手 —— 实测 `provide('fs', …)` 会被拒：
 *   `service "fs" has been registered at <SandboxedFileSystem>`
 * 所以「点开文件时自动从远程拉」做不到。退而求其次的两条：
 *
 *   ① **占位文件**：超限的文件在本地留一个说明文件 —— 以前是直接跳过，
 *      于是它们在界面的文件树里**根本不显示**，用户以为文件不存在
 *   ② **后台补拉**：连上之后把「文本类 + 上限内」的文件补到本地，
 *      这样用户真正会看的文件（源码/配置/文档）点开就有内容
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  materializeTree,
  deepenMirror,
  placeholderContent,
  isPlaceholderText,
  formatBytes,
  isTextLike,
  PLACEHOLDER_MARKER,
  DEFAULT_DEEPEN_BOUNDS,
} from '../src/mirror/tree.js'
import { TRANSPORT_ERROR, TransportError } from '../src/transport/transport.js'

const ROOT = '/remote/proj'

/**
 * 假传输层：`sizes` 可以把某个文件「报成」很大（模拟远端的大文件），
 * 而 `readFile` 仍然返回真实内容 —— 逻辑测试不需要真的造 73 MB。
 */
function fakeTransport(files, options = {}) {
  const sizes = options.sizes ?? {}
  const dirs = new Map()
  const ensure = (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, new Map())
    return dirs.get(dir)
  }
  ensure('')
  for (const rel of Object.keys(files)) {
    const segments = rel.split('/')
    for (let i = 0; i < segments.length; i += 1) {
      const parentRel = segments.slice(0, i).join('/')
      const childRel = segments.slice(0, i + 1).join('/')
      const isLast = i === segments.length - 1
      const children = ensure(parentRel)
      if (isLast) {
        children.set(segments[i], {
          name: segments[i],
          type: 'file',
          size: sizes[childRel] ?? Buffer.byteLength(files[rel], 'utf8'),
          mtimeMs: 1_700_000_000_000,
        })
      } else {
        children.set(segments[i], { name: segments[i], type: 'directory', mtimeMs: 1_700_000_000_000 })
        ensure(childRel)
      }
    }
  }

  const toRel = (path) => {
    if (path === ROOT) return ''
    if (!path.startsWith(`${ROOT}/`)) {
      throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `假 transport 只有 ${ROOT}`, { operation: 'readdir', target: path })
    }
    return path.slice(ROOT.length + 1)
  }

  return {
    kind: 'ssh',
    calls: { readFile: [] },
    async readdir(path, { signal } = {}) {
      if (signal?.aborted === true) throw new TransportError(TRANSPORT_ERROR.ABORTED, '已取消', { operation: 'readdir', target: path })
      const children = dirs.get(toRel(path))
      if (children === undefined) {
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `不存在 ${path}`, { operation: 'readdir', target: path })
      }
      return [...children.values()]
    },
    async readFile(path, { maxBytes } = {}) {
      this.calls.readFile.push(path)
      const rel = toRel(path)
      const content = files[rel]
      if (content === undefined) {
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `不存在 ${rel}`, { operation: 'readFile', target: path })
      }
      const bytes = Buffer.byteLength(content, 'utf8')
      if (maxBytes !== undefined && bytes > maxBytes) {
        throw new TransportError(TRANSPORT_ERROR.TOO_LARGE, `超过上限 ${maxBytes}`, { operation: 'readFile', target: path })
      }
      return content
    },
  }
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mirror-deepen-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ── 纯逻辑 ──────────────────────────────────────────────────────────────────

test('formatBytes：人话的大小', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.00 GB')
  assert.equal(formatBytes('nope'), 'nope', '非数字原样返回，不编一个 0')
})

test('占位内容：说清「在远端、多大、怎么看」', () => {
  const text = placeholderContent({
    relPath: 'projects/mesh.msh',
    remoteRoot: '/home/user/my-proj',
    size: 73 * 1024 * 1024,
    capBytes: 2 * 1024 * 1024,
  })
  assert.ok(isPlaceholderText(text), '第一行必须是标记 —— 靠它认出占位')
  assert.match(text, /73\.0 MB/, '要写清远端大小')
  assert.match(text, /2\.0 MB/, '要写清上限，用户才知道为什么没拉')
  assert.match(text, /\/home\/user\/my-proj\/projects\/mesh\.msh/, '要给完整远端路径')
  assert.match(text, /agent/, '要告诉他怎么才能看到内容')
  // 负对照：只写「未同步」→ 用户不知道是坏了还是故意的
})

test('isTextLike：只认「用户真的会看」的文件', () => {
  for (const ok of ['README.md', 'src/app.ts', 'config.yaml', 'Makefile', 'Dockerfile', '.gitignore', 'data.csv', 'run.sh']) {
    assert.equal(isTextLike(ok), true, `${ok} 应当算文本类`)
  }
  for (const no of ['mesh.msh', 'db.sqlite3', 'photo.png', 'archive.tar.gz', 'model.stl', 'a.exe']) {
    assert.equal(isTextLike(no), false, `${no} 不该被后台拉下来`)
  }
  // 负对照：把 .msh/.sqlite3 也当文本 → 后台补拉会把几 GB 的网格数据搬下来
})

// ── ① 占位文件 ──────────────────────────────────────────────────────────────

test('materializeTree：超限文件在本地留占位（以前是直接跳过）', async () => {
  await withTempDir(async (anchor) => {
    const transport = fakeTransport(
      { 'README.md': '# hi\n', 'big/mesh.msh': 'MESH', 'big/notes.txt': 'x'.repeat(100) },
      { sizes: { 'big/mesh.msh': 73 * 1024 * 1024, 'big/notes.txt': 300 * 1024 } },
    )
    const report = await materializeTree({
      transport,
      anchorPath: anchor,
      remoteRoot: ROOT,
      bounds: { maxDepth: 12, maxEntries: 1000, maxFileBytes: 256 * 1024, maxDurationMs: 5000 },
    })

    // 小文件照常拉内容
    assert.equal(await readFile(join(anchor, 'README.md'), 'utf8'), '# hi\n')
    // 超限文件：本地有文件（**能在文件树里看见**），内容是占位说明
    const placeholder = await readFile(join(anchor, 'big', 'mesh.msh'), 'utf8')
    assert.ok(isPlaceholderText(placeholder), '超大文件应当是占位')
    assert.match(placeholder, /73\.0 MB/)
    // 另一个超限的文本文件（300 KB > 256 KB）也是占位 —— 但会被后台补拉接走
    assert.ok(isPlaceholderText(await readFile(join(anchor, 'big', 'notes.txt'), 'utf8')))

    assert.deepEqual(report.placeholders.map((e) => e.relPath).sort(), ['big/mesh.msh', 'big/notes.txt'])
    assert.equal(report.oversized.length, 2)
    // 负对照：直接跳过 → 这两个文件在界面文件树里根本不出现
  })
})

test('materializeTree：不覆盖已经拉下来的真实内容', async () => {
  await withTempDir(async (anchor) => {
    // 先放一个「真内容」在本地（模拟上一轮已拉取）
    await mkdir(join(anchor, 'big'), { recursive: true })
    await writeFile(join(anchor, 'big', 'notes.txt'), '真实内容')
    const transport = fakeTransport({ 'big/notes.txt': 'x' }, { sizes: { 'big/notes.txt': 5 * 1024 * 1024 } })
    const report = await materializeTree({
      transport,
      anchorPath: anchor,
      remoteRoot: ROOT,
      bounds: { maxDepth: 12, maxEntries: 100, maxFileBytes: 1024, maxDurationMs: 5000 },
    })
    assert.equal(await readFile(join(anchor, 'big', 'notes.txt'), 'utf8'), '真实内容', '不能把真内容换成占位')
    assert.equal(report.placeholders.length, 0)
    // 负对照：无条件写占位 → 已经拉下来的内容被抹掉
  })
})

// ── ② 后台补拉 ──────────────────────────────────────────────────────────────

test('deepenMirror：补文本类、跳过大二进制与非文本', async () => {
  await withTempDir(async (anchor) => {
    const transport = fakeTransport(
      {
        'README.md': '# 大一点的文档\n' + 'x'.repeat(300 * 1024),
        'src/app.ts': 'export const a = 1\n',
        'photo.png': 'PNG',
        'huge.txt': 'y'.repeat(10),
        'already.py': 'print(1)\n',
      },
      { sizes: { 'huge.txt': 5 * 1024 * 1024 } },
    )
    // 先做首轮（上限很小）→ 大文档变成占位
    await materializeTree({
      transport,
      anchorPath: anchor,
      remoteRoot: ROOT,
      bounds: { maxDepth: 12, maxEntries: 500, maxFileBytes: 64 * 1024, maxDurationMs: 5000 },
    })
    assert.ok(isPlaceholderText(await readFile(join(anchor, 'README.md'), 'utf8')), '首轮应当是占位')
    // 首轮也会拉小文件（含 PNG）—— 后面只比较**补拉阶段新增**的调用
    const callsBeforeDeepen = transport.calls.readFile.length

    // 再造一个「已经在本地且不是占位」的文件
    await mkdir(join(anchor, 'already'), { recursive: true })
    await writeFile(join(anchor, 'already.py'), 'print(1)\n')

    const report = await deepenMirror({
      transport,
      anchorPath: anchor,
      remoteRoot: ROOT,
      bounds: { ...DEFAULT_DEEPEN_BOUNDS, maxEntries: 500, maxDurationMs: 5000 },
    })

    // 大文档被补上（占位 → 真实内容）
    const readme = await readFile(join(anchor, 'README.md'), 'utf8')
    assert.ok(!isPlaceholderText(readme), '补拉后不该还是占位')
    assert.match(readme, /大一点的文档/)
    // 小文本也补齐了
    assert.equal(await readFile(join(anchor, 'src', 'app.ts'), 'utf8'), 'export const a = 1\n')
    // 非文本跳过
    const deepenCalls = transport.calls.readFile.slice(callsBeforeDeepen)
    assert.ok(!deepenCalls.includes(`${ROOT}/photo.png`), '补拉不该拉 PNG')
    assert.ok(!deepenCalls.includes(`${ROOT}/huge.txt`), '补拉不该拉 5 MB 的 txt')
    assert.ok(!deepenCalls.includes(`${ROOT}/already.py`), '已在本地的不重复拉')

    // 只补拉「占位的那一个」：src/app.ts 在首轮就拉过了（很小），不该重复拉
    assert.equal(report.fetched, 1, `应当只补拉 1 个，实际 ${report.fetched}`)
    assert.ok(report.bytes > 300 * 1024, '补拉的是那个 300 KB 的文档')
    assert.ok(report.skipped.notText >= 1)
    assert.ok(report.skipped.tooBig >= 1)
    assert.ok(report.skipped.alreadyLocal >= 1)
    // 负对照：不按扩展名过滤 → 几 GB 的网格/数据库会被搬下来
  })
})

test('deepenMirror：总量到顶就停，并如实报告', async () => {
  await withTempDir(async (anchor) => {
    const files = {}
    for (let i = 0; i < 20; i += 1) files[`f${i}.txt`] = 'z'.repeat(50 * 1024)
    const transport = fakeTransport(files)
    const report = await deepenMirror({
      transport,
      anchorPath: anchor,
      remoteRoot: ROOT,
      bounds: { ...DEFAULT_DEEPEN_BOUNDS, maxTotalBytes: 200 * 1024, maxEntries: 500, maxDurationMs: 5000 },
    })
    assert.equal(report.stoppedByBudget, true, '到顶要如实标出来')
    assert.ok(report.bytes <= 200 * 1024 + 60 * 1024, `不该超太多，实际 ${report.bytes}`)
    assert.ok(report.fetched < 20, '不该把 20 个都拉完')
    // 负对照：没有总量上限 → 连一个 8 GB 的工程就往本地灌 8 GB
  })
})

test('deepenMirror：取消是终态，如实抛出（不假装完成）', async () => {
  await withTempDir(async (anchor) => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => deepenMirror({
        transport: fakeTransport({ 'a.txt': 'x' }),
        anchorPath: anchor,
        remoteRoot: ROOT,
        signal: controller.signal,
        bounds: { ...DEFAULT_DEEPEN_BOUNDS, maxEntries: 100, maxDurationMs: 5000 },
      }),
      (error) => error.code === TRANSPORT_ERROR.ABORTED || /取消|abort/i.test(String(error.message)),
    )
    // 负对照：取消后悄悄返回「成功」→ 调用方以为补拉完成了
  })
})
