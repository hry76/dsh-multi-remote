/**
 * `src/mirror/photo.js` 的契约测试。
 *
 * 这一层承担镜像层的核心承诺：**镜像写入不产生额外网络开销**，
 * 以及 **镜像失败绝不能影响 agent**。两条都是可测的行为，不是口号。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, writeFile, stat, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writePhoto, writePhotos, removePhoto, PHOTO_RESULT } from '../src/mirror/photo.js'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mirror-photo-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('writePhoto：把内容写进锚点，必要时建出中间目录', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const outcome = await writePhoto({ anchorPath: anchor, relPath: 'src/util/format.js', content: 'export const f = 1\n' })

    assert.equal(outcome.result, PHOTO_RESULT.WRITTEN)
    assert.equal(outcome.bytes, Buffer.byteLength('export const f = 1\n', 'utf8'))
    assert.equal(await readFile(join(anchor, 'src', 'util', 'format.js'), 'utf8'), 'export const f = 1\n')
    // 负对照：去掉 mkdir(dirname(localPath))，嵌套路径写入会 ENOENT → result 变成 failed
  })
})

test('writePhoto：镜像写入不产生任何额外远程读（零网络开销的证明）', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    // 一个「一旦被调用就爆炸」的 transport —— 照片层根本不该碰它。
    const explodingTransport = {
      async readFile() {
        throw new Error('照片层不该发起任何远程读：内容必须复用 agent 本来就要读的那份')
      },
      async readdir() {
        throw new Error('照片层不该发起任何远程调用')
      },
    }

    // 故意把 transport 传进来（模拟真实调用点的形状），确认它一次都没被用
    const outcome = await writePhoto({
      anchorPath: anchor,
      relPath: 'a.js',
      content: 'x\n',
      transport: explodingTransport,
    })

    assert.equal(outcome.result, PHOTO_RESULT.WRITTEN)
    assert.equal(await readFile(join(anchor, 'a.js'), 'utf8'), 'x\n')
    // 负对照：让 writePhoto 在写之前先 transport.readFile 校验一下内容，
    // 这条测试立刻失败 —— 这正是「零额外网络开销」的机器判据。
  })
})

test('writePhoto：内容一致时跳过写入（不产生无谓的磁盘写入）', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const first = await writePhoto({ anchorPath: anchor, relPath: 'a.txt', content: 'same\n' })
    assert.equal(first.result, PHOTO_RESULT.WRITTEN)

    const second = await writePhoto({ anchorPath: anchor, relPath: 'a.txt', content: 'same\n' })
    assert.equal(second.result, PHOTO_RESULT.UNCHANGED)

    const third = await writePhoto({ anchorPath: anchor, relPath: 'a.txt', content: 'changed\n' })
    assert.equal(third.result, PHOTO_RESULT.WRITTEN)
    assert.equal(await readFile(join(anchor, 'a.txt'), 'utf8'), 'changed\n')
    // 负对照：去掉 isSameContent 短路，第二次会返回 written
  })
})

test('writePhoto：内容一致时确实没有重写文件（用 mtime 证明）', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    await writePhoto({ anchorPath: anchor, relPath: 'a.txt', content: 'same\n' })
    const before = await stat(join(anchor, 'a.txt'))

    await new Promise((resolve) => setTimeout(resolve, 20))
    const outcome = await writePhoto({ anchorPath: anchor, relPath: 'a.txt', content: 'same\n' })
    const after = await stat(join(anchor, 'a.txt'))

    assert.equal(outcome.result, PHOTO_RESULT.UNCHANGED)
    assert.equal(after.mtimeMs, before.mtimeMs, '跳过写入时 mtime 不应变化')
    // 负对照：把 skipUnchanged 默认值改成 false，mtime 会前进
  })
})

test('writePhoto：超过上限只跳过，绝不截断', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const outcome = await writePhoto({
      anchorPath: anchor,
      relPath: 'big.txt',
      content: 'x'.repeat(500),
      maxBytes: 100,
    })
    assert.equal(outcome.result, PHOTO_RESULT.SKIPPED_OVERSIZED)
    assert.equal(outcome.bytes, 500)
    await assert.rejects(() => readFile(join(anchor, 'big.txt'), 'utf8'), /ENOENT/)
    // 负对照：把「超过就跳过」改成「截断到 maxBytes」，文件会存在且只有 100 字节
  })
})

test('writePhoto：镜像失败只回报，不抛异常（绝不能影响 agent）', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    await mkdir(anchor, { recursive: true })
    // 让锚点里同名位置是一个目录 → 文件写不进去
    await mkdir(join(anchor, 'weird'), { recursive: true })

    const outcome = await writePhoto({ anchorPath: anchor, relPath: 'weird', content: 'x\n' })
    assert.equal(outcome.result, PHOTO_RESULT.SKIPPED_NOT_FILE)
    assert.ok(!('error' in outcome) || outcome.error === undefined)
    // 负对照：去掉 isDirectory 检查，writeFile 会抛 EISDIR，
    // 若错误冒泡出去，agent 的一次正常读文件就会失败 —— 本末倒置
  })
})

test('writePhoto：mtime 与远程对齐', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const remoteMtime = 1_700_000_000_000
    await writePhoto({ anchorPath: anchor, relPath: 'a.txt', content: 'x\n', mtimeMs: remoteMtime })

    const info = await stat(join(anchor, 'a.txt'))
    assert.ok(Math.abs(info.mtimeMs - remoteMtime) < 2_000, `实际 mtime=${info.mtimeMs}`)
    // 负对照：去掉 utimes 调用，本地 mtime 是「刚刚」
  })
})

test('writePhoto：围栏拒绝经由符号链接逃出锚点', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const outside = join(dir, 'outside')
    await mkdir(anchor, { recursive: true })
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(anchor, 'escape'), 'junction')

    const { realpath } = await import('node:fs/promises')
    const resolvedAnchor = await realpath(anchor)

    const outcome = await writePhoto({
      anchorPath: anchor,
      relPath: 'escape/pwned.txt',
      content: 'PWNED\n',
      resolvedAnchor,
    })

    assert.equal(outcome.result, PHOTO_RESULT.FAILED, '越界写入必须失败')
    assert.match(outcome.error, /逃出了锚点目录/)
    assert.deepEqual(await readdir(outside), [], '锚点外必须保持干净')
    // 负对照：不传 resolvedAnchor（或去掉 assertWritable），PWNED.txt 会写进锚点外
  })
})

test('writePhotos：批量逐条独立，一条失败不影响其余', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const summary = await writePhotos({
      anchorPath: anchor,
      photos: [
        { relPath: 'a.txt', content: 'a\n' },
        { relPath: 'nested/b.txt', content: 'b\n' },
        { relPath: 'huge.txt', content: 'x'.repeat(500) },
      ],
      maxBytes: 100,
    })

    assert.equal(summary.written, 2)
    assert.equal(summary.skipped, 1)
    assert.equal(summary.failed, 0)
    assert.equal(await readFile(join(anchor, 'a.txt'), 'utf8'), 'a\n')
    assert.equal(await readFile(join(anchor, 'nested', 'b.txt'), 'utf8'), 'b\n')
    assert.equal(summary.results.length, 3)
    // 负对照：把循环改成「遇到跳过就 return」，后一条不会写 → written 变 1
  })
})

test('removePhoto：删掉镜像里的文件，缺失时明确回报', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    await writePhoto({ anchorPath: anchor, relPath: 'a.txt', content: 'x\n' })

    assert.deepEqual(await removePhoto({ anchorPath: anchor, relPath: 'a.txt' }), { result: 'removed' })
    assert.deepEqual(await removePhoto({ anchorPath: anchor, relPath: 'a.txt' }), { result: 'absent' })
    // 负对照：把 ENOENT 当失败返回，第二条会变成 failed
  })
})

test('removePhoto：不递归删目录（避免误删别的照片）', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    await writePhoto({ anchorPath: anchor, relPath: 'keep/a.txt', content: 'a\n' })
    await writePhoto({ anchorPath: anchor, relPath: 'keep/b.txt', content: 'b\n' })

    const outcome = await removePhoto({ anchorPath: anchor, relPath: 'keep' })
    assert.equal(outcome.result, PHOTO_RESULT.FAILED, '对目录调用必须是失败而不是递归删除')
    assert.deepEqual((await readdir(join(anchor, 'keep'))).sort(), ['a.txt', 'b.txt'], '目录内容必须还在')
    // 负对照：把 unlink 换成 rm({recursive:true})，两条照片都会被删掉
  })
})

test('writePhoto：二进制内容按字节比较，不被 UTF-8 解码影响', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80])
    await writePhoto({ anchorPath: anchor, relPath: 'bin.dat', content: bytes })

    const onDisk = await readFile(join(anchor, 'bin.dat'))
    assert.ok(onDisk.equals(bytes))

    const again = await writePhoto({ anchorPath: anchor, relPath: 'bin.dat', content: bytes })
    assert.equal(again.result, PHOTO_RESULT.UNCHANGED)
    // 负对照：把内容统一 String() 再比较，含 NUL 的二进制会被判为「不一致」→ 每次重写
  })
})
