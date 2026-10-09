/**
 * WSL transport 的真机端到端测试。
 *
 * 默认跳过（非 Windows 主机 / 没装 WSL 的贡献者跑不了）。
 * 启用：`DSH_MR_WSL_TEST=1 node --test`
 *
 * 所有读写都限制在 `DSH_MR_WSL_SANDBOX`（默认 `/var/tmp/dsh-mr-wsl-e2e`，**不是 `/tmp`**：
 * 不碰发行版的其他文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WslTransport, listDistros } from '../src/transport/wsl.js'
import { TRANSPORT_ERROR } from '../src/transport/transport.js'

const enabled = process.env.DSH_MR_WSL_TEST === '1'
const DISTRO = process.env.DSH_MR_WSL_DISTRO ?? 'Ubuntu-24.04'
/**
 * 沙箱目录。**刻意不用 `/tmp`**（2026-10-07 实测踩到）：
 *
 * Ubuntu 的 `/usr/lib/tmpfiles.d/tmp.conf` 是 `D /tmp 1777 root root 30d` ——
 * **`D` 的意思是「启动时清空该目录」**，与文件新旧无关。
 * 而 WSL 发行版**空闲约 20 秒就自动停**，所以下一次调用等于一次重启，
 * `/tmp` 里的东西就没了。症状极具误导性：写进去成功，过一会儿核查却「文件不存在」。
 *
 * `/var/tmp` 是「持久临时目录」：实测发行版停掉再起，文件仍在。
 */
const SANDBOX = process.env.DSH_MR_WSL_SANDBOX ?? '/var/tmp/dsh-mr-wsl-e2e'

const skip = enabled ? false : '未设置 DSH_MR_WSL_TEST=1（需要 Windows + WSL2）'

test('真机：枚举发行版', { skip }, async () => {
  const distros = await listDistros()
  assert.ok(distros.length > 0, '至少要有一个发行版')
  assert.ok(distros.includes(DISTRO), `应当包含 ${DISTRO}，实际：${distros.join(', ')}`)
  // 实测：输出是 UTF-16LE 且名字之间有空行 —— 不该出现空字符串
  assert.ok(!distros.includes(''), '不能有空条目（空行要过滤掉）')
})

test('真机：连接 + exec + 文件操作全链路', { skip }, async () => {
  const transport = new WslTransport({ distro: DISTRO })
  await transport.connect()
  try {
    // 清理沙箱
    const setup = await transport.exec(`rm -rf ${SANDBOX} && mkdir -p ${SANDBOX}/sub && echo READY`)
    assert.equal(setup.code, 0, `准备沙箱失败：${setup.stderr}`)
    assert.match(setup.stdout, /READY/)

    // exec：命令真的在 Linux 里跑
    const uname = await transport.exec('uname -s && id -un')
    assert.equal(uname.code, 0)
    assert.match(uname.stdout, /Linux/, '应当是 Linux')
    // ⚠️ **不假设用户名是什么** —— 这是别人机器上的 WSL，用户名由他决定。
    // 只断言「拿到了一个非空的用户名」（第二行）。
    const loginUser = uname.stdout.trim().split('\n').pop().trim()
    assert.match(loginUser, /^\S+$/, `应当以某个 Linux 用户执行，实际：${JSON.stringify(loginUser)}`)

    // cwd
    const pwd = await transport.exec('pwd', { cwd: '/' })
    assert.equal(pwd.stdout.trim(), '/', `--cd 没生效：${pwd.stdout}`)

    // 非零退出码如实回报
    const seven = await transport.exec('exit 7')
    assert.equal(seven.code, 7)

    // 超时
    await assert.rejects(
      () => transport.exec('sleep 30', { timeoutMs: 800 }),
      (error) => error.code === TRANSPORT_ERROR.TIMEOUT,
    )

    // ── 原子写 + 读回（含中文与多字节） ────────────────────────────────
    const file = `${SANDBOX}/hello.txt`
    const content = '你好，WSL\nsecond line\n'
    await transport.writeFileAtomic(file, content)
    assert.equal(await transport.readFile(file, { encoding: 'utf8' }), content)

    // 覆盖写（rename 覆盖已存在文件）
    await transport.writeFileAtomic(file, 'overwritten\n')
    assert.equal(await transport.readFile(file, { encoding: 'utf8' }), 'overwritten\n')

    // stat
    const info = await transport.stat(file)
    assert.equal(info.type, 'file')
    assert.equal(info.size, Buffer.byteLength('overwritten\n', 'utf8'))
    assert.ok(info.mtimeMs > 1_600_000_000_000, `mtime 应当是毫秒：${info.mtimeMs}`)

    // readdir：一次拿到类型与大小
    await transport.writeFileAtomic(`${SANDBOX}/sub/a.js`, 'const a = 1\n')
    const entries = await transport.readdir(`${SANDBOX}/sub`)
    assert.deepEqual(entries.map((entry) => entry.name), ['a.js'])
    assert.equal(entries[0].type, 'file')

    // realpath
    const resolved = await transport.realpath(SANDBOX)
    assert.equal(resolved, SANDBOX)

    // 不存在的路径 → NOT_FOUND
    await assert.rejects(
      () => transport.readFile(`${SANDBOX}/nope.txt`),
      (error) => error.code === TRANSPORT_ERROR.NOT_FOUND,
    )

    // maxBytes 是硬上限，超过要失败而不是截断
    await transport.writeFileAtomic(`${SANDBOX}/big.txt`, 'x'.repeat(5000))
    await assert.rejects(
      () => transport.readFile(`${SANDBOX}/big.txt`, { maxBytes: 100 }),
      (error) => error.code === TRANSPORT_ERROR.TOO_LARGE,
    )
  } finally {
    await transport.exec(`rm -rf ${SANDBOX}`).catch(() => {})
    await transport.disconnect()
  }
})

test('真机：符号链接语义（UNC 做不到的那部分）', { skip }, async () => {
  const transport = new WslTransport({ distro: DISTRO })
  await transport.connect()
  try {
    await transport.exec(`rm -rf ${SANDBOX} && mkdir -p ${SANDBOX}/real && echo target > ${SANDBOX}/real/f.txt && ln -sf real/f.txt ${SANDBOX}/link.txt`)

    // readdir 必须能看见符号链接（UNC 上 readlink 直接 EISDIR）
    const entries = await transport.readdir(SANDBOX)
    const link = entries.find((entry) => entry.name === 'link.txt')
    assert.ok(link, '应当能看到符号链接')
    assert.equal(link.type, 'symlink', '类型应当是 symlink')

    // realpath 应当解析到真实路径
    const resolved = await transport.realpath(`${SANDBOX}/link.txt`)
    assert.equal(resolved, `${SANDBOX}/real/f.txt`)

    // 读符号链接指向的内容
    assert.equal(await transport.readFile(`${SANDBOX}/link.txt`, { encoding: 'utf8' }), 'target\n')
    // 负对照：走 UNC 的话，符号链接的 lstat/stat/readlink 全是错的
  } finally {
    await transport.exec(`rm -rf ${SANDBOX}`).catch(() => {})
    await transport.disconnect()
  }
})

test('真机：并发 16 个请求不打死 WSL（限流生效）', { skip }, async () => {
  const transport = new WslTransport({ distro: DISTRO })
  await transport.connect()
  try {
    const t0 = Date.now()
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => transport.exec(`echo ${i}`)),
    )
    const elapsed = Date.now() - t0

    assert.equal(results.length, 16)
    assert.ok(results.every((result) => result.code === 0), '全部应当成功')
    // 限流下 16 个请求要 4 批，每批约 106ms+ → 远小于「不限流打满」的失败模式
    assert.ok(elapsed < 30_000, `16 个请求耗时 ${elapsed}ms —— 不该出现 30 秒级停顿`)
    // 负对照：去掉限流 → 实测 8 路以上就会 30 秒级停顿 + 50-87% 失败率
  } finally {
    await transport.disconnect()
  }
})
