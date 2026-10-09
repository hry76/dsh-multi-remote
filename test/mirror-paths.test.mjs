/**
 * `src/mirror/paths.js` 的契约测试。
 *
 * 这一层是镜像写入通道的**唯一安全边界**：远程内容 → 本地磁盘。
 * 一旦逃逸就是「远程内容写本地任意文件」，所以负对照必须覆盖到每一种逃逸形态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  toRelativeRemotePath,
  toAnchorPath,
  toRemotePath,
  relativeFromAnchor,
  normalizeRelative,
  normalizeRemoteRoot,
  assertInsideAnchor,
  FenceError,
  FS_SANDBOX_DENIED,
} from '../src/mirror/paths.js'

test('远程根归一化：去尾斜杠、拒绝相对路径与空值', () => {
  assert.equal(normalizeRemoteRoot('/home/user/proj/'), '/home/user/proj')
  assert.equal(normalizeRemoteRoot('/'), '/')
  assert.equal(normalizeRemoteRoot('  /home/user/proj  '), '/home/user/proj')

  assert.throws(() => normalizeRemoteRoot(''), FenceError)
  assert.throws(() => normalizeRemoteRoot('home/user'), /必须是绝对 POSIX 路径/)
  assert.throws(() => normalizeRemoteRoot('/a\0b'), /NUL/)
  // 负对照：去掉 `startsWith('/')` 检查，`home/user` 会被当成有效远程根
})

test('相对路径归一化：吃掉 ./、反斜杠，拒绝 .. 逃逸', () => {
  assert.equal(normalizeRelative('./src/app.js'), 'src/app.js')
  assert.equal(normalizeRelative('src\\app.js'), 'src/app.js')
  assert.equal(normalizeRelative('/src/app.js'), 'src/app.js')
  assert.equal(normalizeRelative('src//app.js'), 'src/app.js')
  assert.equal(normalizeRelative(''), '')
  assert.equal(normalizeRelative('.'), '')

  assert.throws(() => normalizeRelative('..'), FenceError)
  assert.throws(() => normalizeRelative('../../etc/passwd'), FenceError)
  assert.throws(() => normalizeRelative('src/../../etc/passwd'), FenceError)
  // 负对照：去掉 `..` 检查，`../../etc/passwd` 会变成一个正常相对路径
})

test('toRelativeRemotePath：绝对路径落在根内', () => {
  const root = '/home/user/proj'
  assert.equal(toRelativeRemotePath('/home/user/proj/src/app.js', root), 'src/app.js')
  assert.equal(toRelativeRemotePath('/home/user/proj', root), '')
  assert.equal(toRelativeRemotePath('src/app.js', root), 'src/app.js')
  assert.equal(toRelativeRemotePath('./src/./app.js', root), 'src/app.js')
  // 负对照：去掉 posix.resolve，相对路径 `src/app.js` 会被当成根下的字面量
})

test('toRelativeRemotePath：拒绝逃出远程根', () => {
  const root = '/home/user/proj'
  assert.throws(() => toRelativeRemotePath('/etc/passwd', root), (error) => {
    assert.ok(error instanceof FenceError)
    assert.equal(error.code, FS_SANDBOX_DENIED, '拒绝时必须用 FS_SANDBOX_DENIED')
    assert.equal(error.reason, 'escapes-remote-root')
    return true
  })
  assert.throws(() => toRelativeRemotePath('/home/user/proj/../other', root), FenceError)
  assert.throws(() => toRelativeRemotePath('/home/user/projectile/x', root), FenceError)
  // 最后一条是前缀混淆：`/home/user/projectile` 以 `/home/user/proj` 开头但不在根内。
  // 负对照：把 startsWith(`${root}/`) 换成 startsWith(root)，这一条会被放过
})

test('toAnchorPath：逐段拼接，Windows 上也能拆开 POSIX 相对路径', () => {
  assert.equal(toAnchorPath('D:\\anchor', 'src/app.js'), join('D:\\anchor', 'src', 'app.js'))
  assert.equal(toAnchorPath('D:\\anchor', ''), 'D:\\anchor')
  assert.equal(toAnchorPath('/tmp/anchor', 'src/app.js'), '/tmp/anchor/src/app.js')
  assert.throws(() => toAnchorPath('', 'a'), FenceError)
  assert.throws(() => toAnchorPath('D:\\anchor', '../escape'), FenceError)
  // 负对照：把 win32.join(anchor, ...segments) 换成 win32.join(anchor, relative)，
  // Windows 上会得到 `D:\anchor\src/app.js` 这种混合分隔符路径
})

test('本地 ↔ 远程路径可往返', () => {
  const anchor = 'D:\\anchor'
  const remoteRoot = '/home/user/proj'
  const local = toAnchorPath(anchor, 'src/util/format.js')
  assert.equal(relativeFromAnchor(anchor, local), 'src/util/format.js')
  assert.equal(toRemotePath(anchor, remoteRoot, local), '/home/user/proj/src/util/format.js')
  assert.equal(toRemotePath(anchor, remoteRoot, anchor), '/home/user/proj')
  // 负对照：relativeFromAnchor 不归一化反斜杠时，Windows 上会得到 `src\util\format.js`
})

test('assertInsideAnchor：正常路径通过', () => {
  const anchor = 'D:\\anchor'
  assert.equal(assertInsideAnchor(anchor, 'D:\\anchor\\src\\app.js'), 'D:\\anchor\\src\\app.js')
  assert.equal(assertInsideAnchor(anchor, 'D:\\anchor'), 'D:\\anchor')
  // 负对照：无
})

test('assertInsideAnchor：Windows 大小写差异不误判', () => {
  // 同一个目录用不同大小写写法必须判为「在内部」。
  // 若不处理，win32.relative() 会算出 `..\..` 这种假逃逸，把正常写入挡掉。
  assert.doesNotThrow(() => assertInsideAnchor('D:\\Anchor', 'd:\\anchor\\src\\app.js'))
  assert.doesNotThrow(() => assertInsideAnchor('d:\\anchor', 'D:\\ANCHOR\\x'))
  // 负对照：去掉 toLowerCase()，这两条都会抛 FenceError
})

test('assertInsideAnchor：拒绝兄弟目录与上级目录', () => {
  assert.throws(() => assertInsideAnchor('D:\\anchor', 'D:\\anchor-evil\\x'), FenceError)
  assert.throws(() => assertInsideAnchor('D:\\anchor', 'D:\\other\\x'), FenceError)
  assert.throws(() => assertInsideAnchor('D:\\anchor', 'D:\\'), FenceError)
  assert.throws(() => assertInsideAnchor('/tmp/anchor', '/tmp/anchor-evil/x'), FenceError)
  // 负对照：把相对路径比较换成 startsWith，`D:\anchor-evil` 会被放过
})

test('assertInsideAnchor：符号链接逃逸在 realpath 之后被拒绝（核心用例）', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mirror-fence-'))
  try {
    const anchor = join(base, 'anchor')
    const outside = join(base, 'outside')
    await mkdir(anchor, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'SECRET\n', 'utf8')

    // 锚点里放一个指向外部的符号链接
    const link = join(anchor, 'escape')
    await symlink(outside, link, 'junction')

    // 1) 只看字符串：这个路径「看起来」在锚点内 —— 这正是必须 realpath 的原因
    const naive = join(anchor, 'escape', 'secret.txt')
    assert.ok(naive.startsWith(anchor), '前置条件：字符串层面它确实在锚点内')

    // 2) realpath 之后判定 → 必须拒绝
    const resolvedAnchor = await realpath(anchor)
    const resolvedTarget = await realpath(naive)
    assert.throws(
      () => assertInsideAnchor(resolvedAnchor, resolvedTarget, { remotePath: 'escape/secret.txt' }),
      (error) => {
        assert.ok(error instanceof FenceError)
        assert.equal(error.code, FS_SANDBOX_DENIED)
        assert.equal(error.reason, 'escapes-anchor')
        return true
      },
    )
    // 负对照：把 assertInsideAnchor 换成 `target.startsWith(anchor)` 的字符串判断，
    // 这条测试会失败（`<anchor>\escape\secret.txt` 确实以 `<anchor>` 开头）
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('围栏错误对象带 FS_SANDBOX_DENIED 码与可诊断细节', () => {
  try {
    assertInsideAnchor('D:\\anchor', 'D:\\elsewhere\\x', { remotePath: 'x' })
    assert.fail('应当抛出')
  } catch (error) {
    assert.equal(error.name, 'FenceError')
    assert.equal(error.code, 'FS_SANDBOX_DENIED')
    assert.equal(error.remotePath, 'x')
    assert.equal(error.anchorPath, 'd:\\anchor')
    assert.equal(error.reason, 'escapes-anchor')
    assert.ok(error.message.includes('逃出了锚点目录'))
  }
  // 负对照：去掉 FenceError 的 code 赋值，第一条断言失败
})
