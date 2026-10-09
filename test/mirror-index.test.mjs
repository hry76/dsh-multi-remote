/**
 * `src/mirror/index.js` 的契约测试 —— 镜像编排层。
 *
 * 这一层负责两件只有它能做的事，也正是测试重点：
 *   1. **锚点身份**：目录名由「连接档案 + 远程根」稳定派生，不靠目录末段（会撞车）。
 *   2. **远程根变更时整棵重建**：否则两个项目的照片会混在同一个锚点里，
 *      界面上出现根本不存在的文件 —— 这是最容易被忽略、后果又最脏的一种错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Mirror, MirrorState, anchorDirectoryName, STATE_DIR, STATE_FILE } from '../src/mirror/index.js'
import { IgnoreRules } from '../src/mirror/ignore.js'
import { TRANSPORT_ERROR, TransportError } from '../src/transport/transport.js'

/** 内存假 transport，按「根 → 文件表」提供多棵远程树。 */
function fakeTransport(trees) {
  const index = new Map()
  for (const [root, files] of Object.entries(trees)) {
    const dirs = new Map([['', new Map()]])
    const ensure = (dir) => {
      if (!dirs.has(dir)) dirs.set(dir, new Map())
      return dirs.get(dir)
    }
    for (const [rel, content] of Object.entries(files)) {
      const segments = rel.split('/')
      for (let i = 0; i < segments.length; i += 1) {
        const parentRel = segments.slice(0, i).join('/')
        const name = segments[i]
        const children = ensure(parentRel)
        if (i === segments.length - 1) {
          children.set(name, { name, type: 'file', size: Buffer.byteLength(content, 'utf8'), mtimeMs: 1_700_000_000_000 })
        } else {
          children.set(name, { name, type: 'directory', mtimeMs: 1_700_000_000_000 })
          ensure(segments.slice(0, i + 1).join('/'))
        }
      }
    }
    index.set(root, { files, dirs })
  }

  const findRoot = (path) => {
    for (const [root, entry] of index) {
      if (path === root || path.startsWith(`${root}/`)) return [root, entry]
    }
    return undefined
  }

  return {
    kind: 'ssh',
    /** 测试可以直接改远程内容；size 与 mtime 随之变化，模拟真实的远程状态。 */
    setContent(root, rel, content, mtimeMs = 1_700_000_001_000) {
      index.get(root).files[rel] = content
      const segments = rel.split('/')
      const children = index.get(root).dirs.get(segments.slice(0, -1).join('/'))
      children.set(segments.at(-1), {
        name: segments.at(-1),
        type: 'file',
        size: Buffer.byteLength(content, 'utf8'),
        mtimeMs,
      })
    },
    async readdir(path) {
      const found = findRoot(path)
      if (found === undefined) {
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `未知根 ${path}`, { operation: 'readdir', target: path })
      }
      const [root, { dirs }] = found
      const rel = path === root ? '' : path.slice(root.length + 1)
      const children = dirs.get(rel)
      if (children === undefined) {
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `不存在 ${path}`, { operation: 'readdir', target: path })
      }
      return [...children.values()]
    },
    async readFile(path) {
      const found = findRoot(path)
      if (found === undefined) {
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `未知根 ${path}`, { operation: 'readFile', target: path })
      }
      const [root, { files }] = found
      const rel = path.slice(root.length + 1)
      const content = files[rel]
      if (content === undefined) {
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `不存在 ${path}`, { operation: 'readFile', target: path })
      }
      return content
    },
  }
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mirror-index-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('anchorDirectoryName：稳定、区分远程根、不靠目录末段', () => {
  const a = anchorDirectoryName('conn-1', '/home/user/project')
  const b = anchorDirectoryName('conn-1', '/home/user/project')
  assert.equal(a, b, '同一输入必须稳定')

  const differentRoot = anchorDirectoryName('conn-1', '/srv/project')
  assert.notEqual(a, differentRoot, '不同远程根必须不同')

  const differentProfile = anchorDirectoryName('conn-2', '/home/user/project')
  assert.notEqual(a, differentProfile, '不同连接档案必须不同')

  // 关键：两台机器上都有 `project` 这个末段目录，但必须得到不同锚点
  assert.notEqual(
    anchorDirectoryName('conn-1', '/home/user/project'),
    anchorDirectoryName('conn-1', '/srv/other/project'),
    '末段同名不能撞车',
  )
  assert.match(a, /^mr-conn-1-[0-9a-f]{12}$/)
  assert.throws(() => anchorDirectoryName('', '/x'), /非空/)
  // 负对照：把实现改成「取 remoteRoot 的末段目录名」，末段同名的两条会相等
})

test('Mirror.init：拉下目录树、建 git 仓库、提交基线、写状态', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ '/remote/proj': { 'README.md': '# hi\n', 'src/app.js': 'x\n' } })
    const mirror = new Mirror({ transport, anchorPath: anchor, remoteRoot: '/remote/proj', profileId: 'conn-1' })

    const report = await mirror.init()
    assert.deepEqual(report.errors, [])
    assert.equal(report.gitCreated, true)
    assert.equal(report.gitCommitted, true)
    assert.equal(report.written, 2)
    assert.equal(await readFile(join(anchor, 'README.md'), 'utf8'), '# hi\n')

    // 状态文件已写，且被 .gitignore 排除
    const state = await MirrorState.read(anchor)
    assert.equal(state.remoteRoot, '/remote/proj')
    assert.equal(state.profileId, 'conn-1')
    const changes = await mirror.changes()
    assert.equal(changes.porcelain, '', `状态文件不该出现在改动里：${changes.porcelain}`)
    // 负对照：把 STATE_DIR 从 .gitignore 去掉，porcelain 会出现 .dsh-multi-remote/
  })
})

test('Mirror.init：signal 已中止时抛 ABORTED，绝不吞成「部分成功」', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ '/remote/proj': { 'README.md': '# hi\n' } })
    const mirror = new Mirror({ transport, anchorPath: anchor, remoteRoot: '/remote/proj', profileId: 'conn-1' })
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
      () => mirror.init({ signal: controller.signal }),
      (error) => error.code === TRANSPORT_ERROR.ABORTED,
      '取消必须抛出去，让连接层清理锚点 —— 吞成 report.errors 会让取消形同虚设',
    )
    // 负对照：吞掉 ABORTED → connect 照常继续走到预设注册，用户点取消却没反应
  })
})

test('Mirror.init：二次调用不重复提交基线（后续更新要保持未提交）', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ '/remote/proj': { 'a.txt': 'v1\n' } })
    const mirror = new Mirror({ transport, anchorPath: anchor, remoteRoot: '/remote/proj', profileId: 'c' })

    const first = await mirror.init()
    assert.equal(first.gitCommitted, true)

    // 远程内容变了 → 镜像更新，应表现为**未提交的改动**（改动对比要展示的正是它）
    transport.setContent('/remote/proj', 'a.txt', 'v2-longer\n')
    const second = await mirror.init()
    assert.equal(second.gitCommitted, false, '已有基线时不该再提交')

    const changes = await mirror.changes()
    assert.match(changes.porcelain, /M a\.txt/, '镜像更新必须表现为未提交改动')
    // 负对照：把「只在没有基线时提交」改成「每次都提交」，porcelain 会变空
    // —— 界面上就永远看不到 agent 改了什么
  })
})

test('Mirror.init：二次刷新跳过指纹未变的文件（不再拉内容）', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ '/remote/proj': { 'a.txt': 'A\n', 'b.txt': 'B\n' } })
    const mirror = new Mirror({ transport, anchorPath: anchor, remoteRoot: '/remote/proj', profileId: 'c' })

    const first = await mirror.init()
    assert.equal(first.written, 2)
    assert.equal(first.unchanged, 0)

    // 第二次刷新：远程没变 → 一个文件都不该被重新拉下来
    let reads = 0
    const originalReadFile = transport.readFile.bind(transport)
    transport.readFile = async (path, options) => {
      reads += 1
      return originalReadFile(path, options)
    }

    const second = await mirror.init()
    assert.equal(second.written, 0, '指纹未变时不该重新写')
    assert.equal(second.unchanged, 2)
    assert.equal(reads, 0, `不该发起任何远程读，实际 ${reads} 次`)
    // 负对照：去掉 manifest 短路，第二次会重新读并重写两个文件 → written=2、reads=2
  })
})

test('Mirror.init：内容变了但字节数没变时，仍然会被重新拉下来', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ '/remote/proj': { 'a.txt': 'AAAA\n' } })
    const mirror = new Mirror({ transport, anchorPath: anchor, remoteRoot: '/remote/proj', profileId: 'c' })
    await mirror.init()

    // 同样 5 字节，只有内容不同 —— 只比 size 的实现在这里会漏掉
    transport.setContent('/remote/proj', 'a.txt', 'BBBB\n')
    const report = await mirror.init()

    assert.equal(report.written, 1, '内容变化必须被拉下来')
    assert.equal(await readFile(join(anchor, 'a.txt'), 'utf8'), 'BBBB\n')
    // 负对照：把指纹改成只比 size，这条会失败 ——
    // 界面上会永远显示旧内容，而 agent 在远程看到的却是新的
  })
})

test('Mirror.init：远程根变更时整棵重建，绝不混两个项目的照片', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({
      '/remote/projA': { 'from-a.txt': 'A\n', 'shared.txt': 'A\n' },
      '/remote/projB': { 'from-b.txt': 'B\n', 'shared.txt': 'B\n' },
    })

    const mirrorA = new Mirror({ transport, anchorPath: anchor, remoteRoot: '/remote/projA', profileId: 'c' })
    await mirrorA.init()
    assert.deepEqual((await readdir(anchor)).filter((name) => !name.startsWith('.')).sort(), ['from-a.txt', 'shared.txt'])

    // 同一个锚点换成另一个远程根
    const mirrorB = new Mirror({ transport, anchorPath: anchor, remoteRoot: '/remote/projB', profileId: 'c' })
    const report = await mirrorB.init()
    assert.equal(report.rebuilt, true, '远程根变了必须重建')

    const after = (await readdir(anchor)).filter((name) => !name.startsWith('.')).sort()
    assert.deepEqual(after, ['from-b.txt', 'shared.txt'], `A 的文件必须被清掉，实际：${after.join(',')}`)
    assert.equal(await readFile(join(anchor, 'shared.txt'), 'utf8'), 'B\n')
    // 负对照：去掉 remoteChanged 判断，`from-a.txt` 会留在锚点里 ——
    // 界面上就会出现一个远程根本不存在的文件
  })
})

test('Mirror.init：force 触发重建', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ '/remote/proj': { 'a.txt': 'A\n' } })
    const mirror = new Mirror({ transport, anchorPath: anchor, remoteRoot: '/remote/proj', profileId: 'c' })
    await mirror.init()

    // 手工往锚点里塞一个不该存在的文件，模拟残留
    await writeFile(join(anchor, 'stale.txt'), 'stale\n', 'utf8')
    const report = await mirror.init({ force: true })
    assert.equal(report.rebuilt, true)
    await assert.rejects(() => stat(join(anchor, 'stale.txt')), /ENOENT/)
    // 负对照：force 不生效时 stale.txt 会留下
  })
})

test('Mirror.init：重建保留 .git 与状态目录，不会把仓库删掉', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ '/remote/proj': { 'a.txt': 'A\n' } })
    const mirror = new Mirror({ transport, anchorPath: anchor, remoteRoot: '/remote/proj', profileId: 'c' })
    await mirror.init()

    await mirror.init({ force: true })
    assert.ok(await stat(join(anchor, '.git')), '.git 必须保留（否则改动对比的基线就没了）')
    assert.ok(await stat(join(anchor, STATE_DIR, STATE_FILE)), '状态文件必须保留')
    // 负对照：把 wipeContent 换成 rm(anchor, {recursive:true})，.git 会被删掉，
    // 后续 hasBaseline 返回 false → 每次刷新都重新提交基线 → 改动对比永远为空
  })
})

test('Mirror.init：远程读不了时报错但不抛（界面仍能显示已有的照片）', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ '/remote/proj': { 'a.txt': 'A\n' } })
    const mirror = new Mirror({ transport, anchorPath: anchor, remoteRoot: '/remote/proj', profileId: 'c' })
    await mirror.init()

    transport.readdir = async () => {
      throw new TransportError(TRANSPORT_ERROR.CHANNEL_DEAD, '通道已死', { operation: 'readdir', target: '/remote/proj' })
    }
    const report = await mirror.init()
    assert.ok(report.errors.length > 0, '必须上报错误')
    assert.equal(report.errors[0].code, TRANSPORT_ERROR.CHANNEL_DEAD)
    // 已经拉下来的照片还在（镜像容忍过期）
    assert.equal(await readFile(join(anchor, 'a.txt'), 'utf8'), 'A\n')
    // 负对照：让错误冒泡，调用方拿不到报告，也无法区分「远程挂了」和「远程是空的」
  })
})

test('Mirror.photo：写入镜像并复用 agent 的内容，不发起远程读', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ '/remote/proj': { 'a.txt': 'A\n' } })
    const mirror = new Mirror({ transport, anchorPath: anchor, remoteRoot: '/remote/proj', profileId: 'c' })
    await mirror.init()

    transport.readFile = async () => {
      throw new Error('照片层不该发起远程读')
    }
    const outcome = await mirror.photo('src/new.js', 'export const n = 1\n')
    assert.equal(outcome.result, 'written')
    assert.equal(await readFile(join(anchor, 'src', 'new.js'), 'utf8'), 'export const n = 1\n')
    // 负对照：让 photo() 先 transport.readFile 校验，这条立刻失败
  })
})

test('Mirror.localPathOf：给出锚点内的绝对路径', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ '/remote/proj': { 'a.txt': 'A\n' } })
    const mirror = new Mirror({ transport, anchorPath: anchor, remoteRoot: '/remote/proj', profileId: 'c' })
    await mirror.init()
    assert.equal(mirror.localPathOf('src/app.js'), join(anchor, 'src', 'app.js'))
    // 负对照：无
  })
})

test('Mirror.init：真实锚点路径会被 realpath 归一化后再存状态', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    await mkdir(anchor, { recursive: true })
    const transport = fakeTransport({ '/remote/proj': { 'a.txt': 'A\n' } })

    // 用一段「未归一化」的路径构造 Mirror（含 . 段）
    const unnormalized = join(dir, '.', 'anchor')
    const mirror = new Mirror({ transport, anchorPath: unnormalized, remoteRoot: '/remote/proj', profileId: 'c' })
    const report = await mirror.init()

    const { realpath } = await import('node:fs/promises')
    assert.equal(report.resolvedAnchor, await realpath(anchor), 'resolvedAnchor 必须是 realpath 结果')
    // 负对照：把 realpath 换成 path.resolve，符号链接场景下会存下一个对不上的路径，
    // 宿主按 header.cwd 索引时就会找不到这个工作区
  })
})

test('MirrorState：损坏或版本不符的状态视为不存在', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    await mkdir(join(anchor, STATE_DIR), { recursive: true })

    assert.equal(await MirrorState.read(anchor), undefined, '文件缺失应返回 undefined')

    await writeFile(join(anchor, STATE_DIR, STATE_FILE), '{ not json', 'utf8')
    assert.equal(await MirrorState.read(anchor), undefined, '坏 JSON 应返回 undefined')

    await writeFile(join(anchor, STATE_DIR, STATE_FILE), JSON.stringify({ version: 99, remoteRoot: '/x' }), 'utf8')
    assert.equal(await MirrorState.read(anchor), undefined, '版本不符应返回 undefined')
    // 负对照：不做 version 检查，未来改了格式会拿旧状态去判断「远程根没变」而跳过重建
  })
})

test('Mirror.init：项目 .gitignore 通过 ignore 选项生效', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({
      '/remote/proj': { 'src/a.js': 'x\n', 'vendor/v.js': 'y\n', 'node_modules/d/i.js': 'z\n' },
    })
    const mirror = new Mirror({
      transport,
      anchorPath: anchor,
      remoteRoot: '/remote/proj',
      profileId: 'c',
      ignore: IgnoreRules.parse('vendor/\n'),
    })
    await mirror.init()

    const entries = (await readdir(anchor)).filter((name) => !name.startsWith('.')).sort()
    assert.deepEqual(entries, ['src'], `实际：${entries.join(',')}`)
    // 负对照：忽略 ignore 选项，vendor 与 node_modules 都会出现
  })
})

test('镜像：在界面上手改镜像**不会**影响远程', async () => {
  // 这条对应「镜像只给界面看、远程是唯一真相」这个定位。
  // 用户完全可能在界面的编辑器里改镜像里的文件 —— 必须保证那只是本地副本。
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ '/remote/proj': { 'a.txt': '远程原版\n' } })
    const mirror = new Mirror({ transport, anchorPath: anchor, remoteRoot: '/remote/proj', profileId: 'c' })
    await mirror.init()

    // 用户（或界面）改镜像里的文件
    await writeFile(join(anchor, 'a.txt'), '我在界面上改的\n', 'utf8')

    // 远程必须纹丝不动
    assert.equal(
      await transport.readFile('/remote/proj/a.txt', { encoding: 'utf8' }),
      '远程原版\n',
      '镜像里的编辑绝不能回写到远程 —— 镜像只是只读副本',
    )
    // 负对照：把镜像的写入转发到远程（例如为了「双向同步」）→ 界面上的误编辑会改坏远端
  })
})

test('镜像：刷新**不会**覆盖界面上手改的镜像（远程未变时按指纹跳过）', async () => {
  // 这条是上面那条的另一半，也解释了「为什么手改能留住」：
  // 跳过与否看的是**远程**指纹，不是本地文件的 mtime —— 所以本地改了也不会被重拉覆盖。
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const transport = fakeTransport({ '/remote/proj': { 'a.txt': '远程原版\n' } })
    const mirror = new Mirror({ transport, anchorPath: anchor, remoteRoot: '/remote/proj', profileId: 'c' })
    await mirror.init()

    await writeFile(join(anchor, 'a.txt'), '本地改过的\n', 'utf8')
    await mirror.refresh()

    assert.equal(
      await readFile(join(anchor, 'a.txt'), 'utf8'),
      '本地改过的\n',
      '远程没变时刷新应当跳过这个文件，本地编辑得以保留',
    )
    // 负对照：无条件重写 → 用户每次刷新都会丢失界面上的编辑

    // 但远程**变了**的时候，镜像必须被拉成远程的新内容（远程才是真相）
    transport.setContent('/remote/proj', 'a.txt', '远程改过了\n')
    await mirror.refresh()
    assert.equal(
      await readFile(join(anchor, 'a.txt'), 'utf8'),
      '远程改过了\n',
      '远程变了就必须覆盖本地 —— 否则界面会一直显示过时内容',
    )
    // 负对照：只看本地 mtime 判断「要不要重拉」→ 远程的改动永远显示不出来
  })
})
