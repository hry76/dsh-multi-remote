/**
 * `src/mirror/tree.js` 的契约测试。
 *
 * 重点不在「能把目录拉下来」，而在**边界与失败语义**：
 * 参考项目在这三件事上都栽过 —— 遍历不可取消、readdir 失败当空目录、没有墙钟预算。
 * 所以每条都配负对照。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir, stat, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { walkRemoteTree, materializeTree, DEFAULT_TREE_BOUNDS, TRUNCATION_REASON } from '../src/mirror/tree.js'
import { IgnoreRules, BUILTIN_IGNORES } from '../src/mirror/ignore.js'
import { TRANSPORT_ERROR, TransportError } from '../src/transport/transport.js'

/**
 * 内存假 transport。
 * `files` 用「相对远程根的路径 → 内容」描述；目录自动推导。
 * @param {Record<string, string>} files
 * @param {{ unreadableDirs?: string[], abortOn?: string, sizeOverride?: Record<string, number> }} [options]
 */
function fakeTransport(files, options = {}) {
  const unreadable = new Set(options.unreadableDirs ?? [])
  const sizeOverride = options.sizeOverride ?? {}
  const root = '/remote/proj'

  /** 把 files 的键展开成「目录 → 直接子项」索引。 */
  const dirs = new Map()
  const ensure = (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, new Map())
    return dirs.get(dir)
  }
  ensure('')
  for (const [rel, content] of Object.entries(files)) {
    const segments = rel.split('/')
    for (let i = 0; i < segments.length; i += 1) {
      const parentRel = segments.slice(0, i).join('/')
      const name = segments[i]
      const isLast = i === segments.length - 1
      const children = ensure(parentRel)
      const childRel = segments.slice(0, i + 1).join('/')
      if (isLast) {
        children.set(name, {
          name,
          type: 'file',
          size: sizeOverride[childRel] ?? Buffer.byteLength(content, 'utf8'),
          mtimeMs: 1_700_000_000_000,
        })
      } else {
        children.set(name, { name, type: 'directory', mtimeMs: 1_700_000_000_000 })
        ensure(childRel)
      }
    }
  }

  const absolute = (rel) => (rel === '' ? root : `${root}/${rel}`)
  const toRel = (path) => {
    if (path === root) return ''
    // 根之外的路径按「不存在」处理，而不是抛一个无 code 的普通错误 ——
    // 后者会被上层归类成 TRANSPORT_UNKNOWN，掩盖真实的 NOT_FOUND。
    if (!path.startsWith(`${root}/`)) {
      throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `假 transport 只提供 ${root}，收到 ${path}`, {
        operation: 'readdir',
        target: path,
      })
    }
    return path.slice(root.length + 1)
  }

  return {
    kind: 'ssh',
    calls: { readdir: [], readFile: [] },
    async readdir(path, { signal } = {}) {
      this.calls.readdir.push(path)
      const rel = toRel(path)
      if (options.abortOn !== undefined && rel === options.abortOn) {
        throw new TransportError(TRANSPORT_ERROR.ABORTED, '已取消', { operation: 'readdir', target: path })
      }
      if (signal?.aborted === true) {
        throw new TransportError(TRANSPORT_ERROR.ABORTED, '已取消', { operation: 'readdir', target: path })
      }
      if (unreadable.has(rel)) {
        throw new TransportError(TRANSPORT_ERROR.PERMISSION_DENIED, `读不了 ${rel}`, { operation: 'readdir', target: path })
      }
      const children = dirs.get(rel)
      if (children === undefined) {
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `不存在 ${rel}`, { operation: 'readdir', target: path })
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
  const dir = await mkdtemp(join(tmpdir(), 'mirror-tree-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const relPaths = (entries) => entries.map((entry) => entry.relPath).sort()

test('walkRemoteTree：遍历目录树，目录与文件都在', async () => {
  const transport = fakeTransport({
    'README.md': '# hi\n',
    'src/app.js': 'export const a = 1\n',
    'src/util/f.js': 'export const f = 1\n',
    'docs/x.md': '# x\n',
  })
  const result = await walkRemoteTree({ transport, remoteRoot: '/remote/proj' })

  assert.deepEqual(relPaths(result.entries), ['README.md', 'docs', 'docs/x.md', 'src', 'src/app.js', 'src/util', 'src/util/f.js'])
  assert.equal(result.stats.files, 4)
  assert.equal(result.stats.directories, 3)
  assert.equal(result.errors.length, 0)
  assert.equal(result.truncated, false)
  // 负对照：去掉子目录入队，只会拿到根下的一层
})

test('walkRemoteTree：忽略的目录整棵剪掉，不再下潜', async () => {
  const transport = fakeTransport({
    'src/app.js': 'x\n',
    'node_modules/dep/index.js': 'y\n',
    'node_modules/dep/deep/z.js': 'z\n',
    'dist/bundle.js': 'w\n',
  })
  const result = await walkRemoteTree({ transport, remoteRoot: '/remote/proj' })

  assert.deepEqual(relPaths(result.entries), ['src', 'src/app.js'])
  assert.ok(
    !transport.calls.readdir.some((path) => path.includes('node_modules')),
    '被忽略的目录不该被 readdir —— 必须整棵剪掉',
  )
  // 负对照：把忽略判定挪到「只对文件」上，就会去 readdir node_modules（这条断言变红）
})

test('walkRemoteTree：项目 .gitignore 与内置规则合并生效', async () => {
  const transport = fakeTransport({
    'src/app.js': 'x\n',
    'vendor/lib.js': 'y\n',
    'node_modules/dep/i.js': 'z\n',
  })
  const ignore = IgnoreRules.merge(BUILTIN_IGNORES, IgnoreRules.parse('vendor/\n'))
  const result = await walkRemoteTree({ transport, remoteRoot: '/remote/proj', ignore })
  assert.deepEqual(relPaths(result.entries), ['src', 'src/app.js'])
  // 负对照：只用 BUILTIN_IGNORES，`vendor` 会出现在结果里
})

test('walkRemoteTree：深度上限截断并上报原因', async () => {
  const transport = fakeTransport({
    'a/b/c/d/e/f.txt': 'deep\n',
  })
  const result = await walkRemoteTree({
    transport,
    remoteRoot: '/remote/proj',
    bounds: { ...DEFAULT_TREE_BOUNDS, maxDepth: 3 },
  })
  assert.equal(result.truncated, true)
  assert.ok(result.reasons.includes(TRUNCATION_REASON.DEPTH))
  assert.ok(!relPaths(result.entries).includes('a/b/c/d/e/f.txt'), '超过深度的不该被访问')
  // 负对照：去掉 maxDepth 检查，会一路走到 f.txt
})

test('walkRemoteTree：条目数上限截断并上报原因', async () => {
  const files = {}
  for (let i = 0; i < 50; i += 1) files[`f${String(i).padStart(2, '0')}.txt`] = 'x\n'
  const transport = fakeTransport(files)
  const result = await walkRemoteTree({
    transport,
    remoteRoot: '/remote/proj',
    bounds: { ...DEFAULT_TREE_BOUNDS, maxEntries: 10 },
  })
  assert.equal(result.truncated, true)
  assert.ok(result.reasons.includes(TRUNCATION_REASON.ENTRIES))
  assert.ok(result.entries.length <= 10, `实际访问 ${result.entries.length} 条`)
  // 负对照：去掉 maxEntries 检查，50 个文件全被访问
})

test('walkRemoteTree：墙钟预算到点就停（遍历可中断）', async () => {
  const files = {}
  for (let i = 0; i < 20; i += 1) files[`d${i}/f.txt`] = 'x\n'
  const transport = fakeTransport(files)

  // 假时钟：每次读取推进 1 秒，预算 3 秒 → 必须提前停下
  let clock = 0
  const result = await walkRemoteTree({
    transport,
    remoteRoot: '/remote/proj',
    bounds: { ...DEFAULT_TREE_BOUNDS, maxDurationMs: 3_000 },
    now: () => {
      clock += 1_000
      return clock
    },
  })
  assert.equal(result.truncated, true)
  assert.ok(result.reasons.includes(TRUNCATION_REASON.TIME))
  assert.ok(result.entries.length < 20, `应当提前停止，实际访问 ${result.entries.length} 条`)
  // 负对照：去掉 now() > deadline 检查，20 个目录会被全部访问
})

test('walkRemoteTree：readdir 失败记为错误，绝不静默当成空目录', async () => {
  const transport = fakeTransport(
    { 'src/app.js': 'x\n', 'secret/hidden.js': 'y\n' },
    { unreadableDirs: ['secret'] },
  )
  const result = await walkRemoteTree({ transport, remoteRoot: '/remote/proj' })

  assert.deepEqual(relPaths(result.entries), ['secret', 'src', 'src/app.js'].sort())
  assert.equal(result.errors.length, 1, '必须恰好记一条错误')
  assert.equal(result.errors[0].path, '/remote/proj/secret')
  assert.equal(result.errors[0].code, TRANSPORT_ERROR.PERMISSION_DENIED)
  // 关键：这个目录**在结果里有条目但内容为空**，调用方必须能看出「这是失败的，
  // 不是空的」。负对照：把 catch 改成 `children = []`，errors 会变空 → 界面
  // 静默显示「secret 是空目录」，用户永远不知道丢了东西。
})

test('walkRemoteTree：取消是终态，立刻抛 ABORTED 而不是回退', async () => {
  const transport = fakeTransport({ 'src/app.js': 'x\n' }, { abortOn: 'src' })
  await assert.rejects(
    () => walkRemoteTree({ transport, remoteRoot: '/remote/proj' }),
    (error) => {
      assert.equal(error.code, TRANSPORT_ERROR.ABORTED)
      assert.equal(error.operation, 'walkRemoteTree')
      return true
    },
  )
  // 负对照：把取消当成普通错误塞进 errors[]，这里会正常 resolve 而不是 reject
})

test('walkRemoteTree：外部 signal 取消时立刻停', async () => {
  const controller = new AbortController()
  const transport = fakeTransport({ 'src/app.js': 'x\n' })
  controller.abort()
  await assert.rejects(
    () => walkRemoteTree({ transport, remoteRoot: '/remote/proj', signal: controller.signal }),
    (error) => error.code === TRANSPORT_ERROR.ABORTED,
  )
  // 负对照：去掉 throwIfAborted 的首个调用点，会先跑一次 readdir 才失败
})

test('materializeTree：目录骨架 + 小文件内容都落到锚点', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({
      'README.md': '# 远程项目\n',
      'src/app.js': 'export const a = 1\n',
      'src/util/f.js': 'export const f = 1\n',
    })
    const result = await materializeTree({ transport, anchorPath: anchor, remoteRoot: '/remote/proj' })

    assert.equal(await readFile(join(anchor, 'README.md'), 'utf8'), '# 远程项目\n')
    assert.equal(await readFile(join(anchor, 'src', 'app.js'), 'utf8'), 'export const a = 1\n')
    assert.equal(await readFile(join(anchor, 'src', 'util', 'f.js'), 'utf8'), 'export const f = 1\n')
    assert.equal(result.written.length, 3)
    assert.equal(result.oversized.length, 0)
    // 负对照：去掉 mkdir(dirname(localPath))，嵌套目录写入会 ENOENT
  })
})

test('materializeTree：超过单文件上限的只留占位，不拉内容', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport(
      { 'small.txt': 'ok\n', 'big.bin': 'x'.repeat(500) },
      { sizeOverride: { 'big.bin': 10_000 } },
    )
    const result = await materializeTree({
      transport,
      anchorPath: anchor,
      remoteRoot: '/remote/proj',
      bounds: { ...DEFAULT_TREE_BOUNDS, maxFileBytes: 100 },
    })

    assert.deepEqual(result.written.map((entry) => entry.relPath), ['small.txt'])
    assert.deepEqual(result.oversized.map((entry) => entry.relPath), ['big.bin'])
    assert.ok(!transport.calls.readFile.some((path) => path.endsWith('big.bin')), '大文件不该被读下来')
    // 负对照：去掉 size > maxFileBytes 检查，会去 readFile 大文件（假 transport 会抛 TOO_LARGE，
    // 结果从 oversized 变成 errors —— 两种失败模式在结果里是分开的）
  })
})

test('materializeTree：单个文件失败不放弃整棵树', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
    const original = transport.readFile.bind(transport)
    transport.readFile = async (path, options) => {
      if (path.endsWith('a.txt')) {
        throw new TransportError(TRANSPORT_ERROR.PERMISSION_DENIED, '读不了', { operation: 'readFile', target: path })
      }
      return original(path, options)
    }

    const result = await materializeTree({ transport, anchorPath: anchor, remoteRoot: '/remote/proj' })
    assert.deepEqual(result.written.map((entry) => entry.relPath), ['b.txt'])
    assert.equal(result.errors.length, 1)
    assert.equal(await readFile(join(anchor, 'b.txt'), 'utf8'), 'b\n')
    // 负对照：让 readFile 的错误直接冒泡，整棵树会中断，b.txt 也不会被写
  })
})

test('materializeTree：transport 有 readFilesBatch 就走批量，一次拿全', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const base = fakeTransport({ 'a.txt': 'A\n', 'sub/b.txt': 'B\n', 'c.txt': 'C\n' })
    // 挂上批量能力（模拟 WSL）—— 记录调用，内容从假文件表取
    const batchCalls = []
    base.readFilesBatch = async (paths, options) => {
      batchCalls.push(paths)
      const out = new Map()
      for (const path of paths) {
        const rel = path.replace('/remote/proj/', '').replace('/remote/proj', '')
        const content = {
          'a.txt': 'A\n', 'sub/b.txt': 'B\n', 'c.txt': 'C\n',
        }[rel]
        if (content === undefined) {
          out.set(path, { ok: false, error: new TransportError(TRANSPORT_ERROR.NOT_FOUND, '不存在', { operation: 'readFile', target: path }) })
        } else {
          out.set(path, { ok: true, data: Buffer.from(content, 'utf8') })
        }
      }
      return out
    }

    const result = await materializeTree({ transport: base, anchorPath: anchor, remoteRoot: '/remote/proj' })

    // 全部内容都写下来了
    assert.deepEqual(result.written.map((e) => e.relPath).sort(), ['a.txt', 'c.txt', 'sub/b.txt'])
    assert.equal(await readFile(join(anchor, 'a.txt'), 'utf8'), 'A\n')
    assert.equal(await readFile(join(anchor, 'sub', 'b.txt'), 'utf8'), 'B\n')
    assert.equal(await readFile(join(anchor, 'c.txt'), 'utf8'), 'C\n')

    // **一次**批量调用拿全（这就是 WSL 上 22s→2s 的来源）
    assert.equal(batchCalls.length, 1, '三个文件应当一批拿全')
    // 批量路径下不该再走逐个 readFile
    assert.equal(base.calls.readFile.length, 0, '有批量能力时不应退回逐个读')
    // 负对照：不用批量 → 197 个文件 197 次 spawn，实测 22 秒
  })
})

test('materializeTree：批量整批失败时降级回逐个读（语义不变）', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const base = fakeTransport({ 'a.txt': 'A\n', 'b.txt': 'B\n' })
    // 批量能力存在但**总是失败**（比如脚本在这个发行版里跑不了）
    let batchTried = 0
    base.readFilesBatch = async () => {
      batchTried += 1
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, '批量读失败', { operation: 'readFilesBatch' })
    }

    const result = await materializeTree({ transport: base, anchorPath: anchor, remoteRoot: '/remote/proj' })

    assert.equal(batchTried, 1, '批量先试了一次')
    // 降级后内容照样全 —— 用户看到的行为完全一致
    assert.deepEqual(result.written.map((e) => e.relPath).sort(), ['a.txt', 'b.txt'])
    assert.equal(await readFile(join(anchor, 'a.txt'), 'utf8'), 'A\n')
    assert.equal(await readFile(join(anchor, 'b.txt'), 'utf8'), 'B\n')
    assert.equal(base.calls.readFile.length, 2, '整批失败后逐个读补上')
    assert.equal(result.errors.length, 0, '降级不产生错误')
    // 负对照：批量失败直接抛 → 用户看到「打开失败」，而其实退一步就能成
  })
})

test('materializeTree：批量里单个文件失败只记那个文件，其余照常', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const base = fakeTransport({ 'a.txt': 'A\n', 'b.txt': 'B\n', 'c.txt': 'C\n' })
    base.readFilesBatch = async (paths) => {
      const out = new Map()
      for (const path of paths) {
        if (path.endsWith('b.txt')) {
          out.set(path, { ok: false, error: new TransportError(TRANSPORT_ERROR.PERMISSION_DENIED, '权限不足', { operation: 'readFile', target: path }) })
        } else {
          const rel = path.replace('/remote/proj/', '')
          out.set(path, { ok: true, data: Buffer.from({ 'a.txt': 'A\n', 'c.txt': 'C\n' }[rel], 'utf8') })
        }
      }
      return out
    }

    const result = await materializeTree({ transport: base, anchorPath: anchor, remoteRoot: '/remote/proj' })
    assert.deepEqual(result.written.map((e) => e.relPath).sort(), ['a.txt', 'c.txt'])
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].code, TRANSPORT_ERROR.PERMISSION_DENIED)
    assert.equal(await readFile(join(anchor, 'a.txt'), 'utf8'), 'A\n')
    assert.equal(await readFile(join(anchor, 'c.txt'), 'utf8'), 'C\n')
    // 负对照：一个文件失败拖垮整批 → 权限问题让整个项目打不开
  })
})

test('materializeTree：transport 有 walkTree 就走快路拿结构，内容仍走批量/逐个', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const base = fakeTransport({ 'README.md': 'A\n', 'src/app.js': 'const a=1\n', 'big.bin': 'x' })
    let walkTreeCalls = 0
    base.walkTree = async (remoteRoot, options) => {
      walkTreeCalls += 1
      // 快路只给**元数据**（无 data）—— 内容交给 readFilesBatch/readFile
      return {
        entries: [
          { relPath: 'src', type: 'directory', mtimeMs: 1 },
          { relPath: 'README.md', type: 'file', size: 2, mtimeMs: 2 },
          { relPath: 'src/app.js', type: 'file', size: 10, mtimeMs: 3 },
          { relPath: 'big.bin', type: 'file', size: 999999, mtimeMs: 4 }, // 超限
        ],
        truncated: false,
        durationMs: 42,
      }
    }

    const result = await materializeTree({ transport: base, anchorPath: anchor, remoteRoot: '/remote/proj' })

    assert.equal(walkTreeCalls, 1, '有 walkTree 就只走一次快路')
    assert.equal(base.calls.readdir.length, 0, '快路不走 readdir')
    // 内容仍走标准拉取（这里没有 readFilesBatch，所以逐个 readFile）
    assert.equal(base.calls.readFile.length, 2, '两个小文件走 readFile 拉内容')

    // 文件内容写下来了
    assert.equal(await readFile(join(anchor, 'README.md'), 'utf8'), 'A\n')
    assert.equal(await readFile(join(anchor, 'src', 'app.js'), 'utf8'), 'const a=1\n')
    // 目录骨架建出来了
    assert.ok((await stat(join(anchor, 'src'))).isDirectory())
    // 超限文件留占位
    const placeholder = await readFile(join(anchor, 'big.bin'), 'utf8')
    assert.match(placeholder, /dsh-multi-remote:not-synced/)
    // 统计正确
    assert.equal(result.written.length, 2, '两个小文件落盘')
    assert.equal(result.oversized.length, 1, '一个大文件占位')
    assert.equal(result.stats.viaFind, true)
    // 负对照：无视 walkTree 能力 → 又退回逐目录 readdir
  })
})

test('materializeTree：walkTree 探测失败时静默退回标准路（语义不变）', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const base = fakeTransport({ 'a.txt': 'A\n', 'b.txt': 'B\n' })
    let walkTreeTried = 0
    base.walkTree = async () => {
      walkTreeTried += 1
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, '远端没有 GNU find', { operation: 'walkTree' })
    }

    const result = await materializeTree({ transport: base, anchorPath: anchor, remoteRoot: '/remote/proj' })

    assert.equal(walkTreeTried, 1, '快路先试了一次')
    assert.deepEqual(result.written.map((e) => e.relPath).sort(), ['a.txt', 'b.txt'], '降级后内容照常')
    assert.equal(await readFile(join(anchor, 'a.txt'), 'utf8'), 'A\n')
    assert.equal(base.calls.readFile.length, 2, '退回标准路逐个读')
    assert.equal(result.stats.viaFind, undefined, '统计里不该标 viaFind')
    assert.equal(result.errors.length, 0, '降级不产生错误')
    // 负对照：walkTree 失败直接抛 → 用户看到「打开失败」，而退一步就能成
  })
})

test('materializeTree：walkTree 快路也要应用忽略规则（目录整棵剪掉）', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    // walkTree 返回全量（含 node_modules 及子孙）—— 快路必须像标准路一样剪掉忽略目录
    const base = fakeTransport({ 'keep.txt': 'K\n' })
    base.walkTree = async () => ({
      entries: [
        { relPath: 'keep.txt', type: 'file', size: 2, mtimeMs: 1 },
        { relPath: 'node_modules', type: 'directory', mtimeMs: 1 },
        { relPath: 'node_modules/evil.js', type: 'file', size: 10, mtimeMs: 1 },
        { relPath: 'node_modules/deep/', type: 'directory', mtimeMs: 1 },
        { relPath: 'node_modules/deep/x.js', type: 'file', size: 10, mtimeMs: 1 },
      ],
      truncated: false,
      durationMs: 1,
    })

    const result = await materializeTree({ transport: base, anchorPath: anchor, remoteRoot: '/remote/proj' })

    // node_modules 及子孙都被剪掉，只有 keep.txt 落盘
    assert.deepEqual(result.written.map((e) => e.relPath), ['keep.txt'])
    assert.equal(base.calls.readFile.length, 1, '只有 keep.txt 拉内容')
    await assert.rejects(() => stat(join(anchor, 'node_modules')), /ENOENT/, '被忽略目录不该建骨架')
    // 负对照：快路不应用 ignore → node_modules 整个被拉下来（12659 文件项目里就是灾难）
  })
})

test('materializeTree：符号链接与特殊文件不搬内容', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ 'real.txt': 'r\n' })
    const original = transport.readdir.bind(transport)
    transport.readdir = async (path, options) => {
      const children = await original(path, options)
      if (path === '/remote/proj') {
        return [...children, { name: 'link', type: 'other', mtimeMs: 1 }]
      }
      return children
    }

    const result = await materializeTree({ transport, anchorPath: anchor, remoteRoot: '/remote/proj' })
    assert.deepEqual(result.written.map((entry) => entry.relPath), ['real.txt'])
    await assert.rejects(() => stat(join(anchor, 'link')), /ENOENT/)
    // 负对照：把 type !== 'file' 的短路去掉，会尝试 readFile('link') 并产生一条错误
  })
})

test('materializeTree：mtime 与远程对齐（「跳过未变化」判断的前提）', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ 'a.txt': 'a\n' })
    await materializeTree({ transport, anchorPath: anchor, remoteRoot: '/remote/proj' })

    const info = await stat(join(anchor, 'a.txt'))
    // 假 transport 固定给 1_700_000_000_000ms；允许 2s 的文件系统粒度误差
    assert.ok(
      Math.abs(info.mtimeMs - 1_700_000_000_000) < 2_000,
      `本地 mtime 应与远程对齐，实际 ${info.mtimeMs}`,
    )
    // 负对照：去掉 utimes 调用，本地 mtime 是「刚刚」，与远程差好几年 → 每次刷新都重传
  })
})

test('materializeTree：每处理完一个目录就回调（供调用方做检查点）', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ 'a/x.txt': 'x\n', 'b/y.txt': 'y\n' })
    /** @type {string[]} */
    const done = []
    await materializeTree({
      transport,
      anchorPath: anchor,
      remoteRoot: '/remote/proj',
      onFileWritten: (entry) => {
        done.push(entry.relPath)
      },
    })
    assert.deepEqual(done.sort(), ['a/x.txt', 'b/y.txt'])
    // 负对照：不调用 onFileWritten，done 为空 → 调用方无法做逐目录检查点
  })
})

test('materializeTree：忽略规则同样作用于落盘', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({
      'src/app.js': 'x\n',
      'node_modules/dep/i.js': 'y\n',
    })
    await materializeTree({ transport, anchorPath: anchor, remoteRoot: '/remote/proj' })

    const rootEntries = await readdir(anchor)
    assert.ok(rootEntries.includes('src'))
    assert.ok(!rootEntries.includes('node_modules'), '被忽略的目录不该出现在锚点里')
    // 负对照：落盘不传 ignore，node_modules 会出现在锚点里
  })
})

test('materializeTree：远程根不存在时记错误而不是抛崩', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({})
    const result = await materializeTree({ transport, anchorPath: anchor, remoteRoot: '/remote/nope' })
    // 假 transport 只认 /remote/proj，所以这里会走 readdir 的失败分支
    assert.equal(result.written.length, 0)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].code, TRANSPORT_ERROR.NOT_FOUND)
    // 负对照：让 readdir 失败冒泡，整个调用会 reject，调用方拿不到「部分成功」的结果
  })
})

test('materializeTree：拒绝经由符号链接逃出锚点', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const outside = join(dir, 'outside')
    await mkdir(anchor, { recursive: true })
    await mkdir(outside, { recursive: true })
    // 锚点里预置一个指向外部的目录联接，模拟「远程内容诱导写入逃逸」
    await symlink(outside, join(anchor, 'escape'), 'junction')

    const transport = fakeTransport({ 'escape/pwned.txt': 'PWNED\n' })
    const result = await materializeTree({ transport, anchorPath: anchor, remoteRoot: '/remote/proj' })

    // 围栏应当拒绝写入；外面那个目录必须保持干净
    assert.equal(result.written.length, 0, '越界写入必须被拒绝')
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0].message, /逃出了锚点目录/)
    const outsideEntries = await readdir(outside)
    assert.deepEqual(outsideEntries, [], `锚点外的目录必须保持空，实际：${outsideEntries.join(',')}`)
    // 负对照：把 assertWritable 去掉，PWNED.txt 会被写进锚点外的目录
  })
})

test('materializeTree：取消时抛 ABORTED，不留下半棵树当成功', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ 'a/x.txt': 'x\n' }, { abortOn: 'a' })
    await assert.rejects(
      () => materializeTree({ transport, anchorPath: anchor, remoteRoot: '/remote/proj' }),
      (error) => error.code === TRANSPORT_ERROR.ABORTED,
    )
    // 负对照：把取消塞进 errors[]，调用方会把「被取消」误当成「成功但目录是空的」
  })
})
