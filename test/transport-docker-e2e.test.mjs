/**
 * Docker transport 的真机端到端测试。
 *
 * 默认跳过（没有运行中的容器时跑不了）。
 * 启用：`DSH_MR_DOCKER_TEST=1 DSH_MR_DOCKER_CONTAINER=<名字> node --test`
 *
 * 所有读写限制在 `DSH_MR_DOCKER_SANDBOX`（默认 `/tmp/dsh-mr-docker-e2e`）里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DockerTransport, DockerClient, parseMultiplexed } from '../src/transport/docker.js'
import { TRANSPORT_ERROR } from '../src/transport/transport.js'

const enabled = process.env.DSH_MR_DOCKER_TEST === '1'
const CONTAINER = process.env.DSH_MR_DOCKER_CONTAINER ?? 'dsh-mr-test'
const SANDBOX = process.env.DSH_MR_DOCKER_SANDBOX ?? '/tmp/dsh-mr-docker-e2e'

const skip = enabled ? false : '未设置 DSH_MR_DOCKER_TEST=1（需要运行中的容器）'

test('真机：守护进程握手 + 列容器', { skip }, async () => {
  const client = new DockerClient()
  const handshake = await client.handshake()
  assert.ok(handshake.apiVersion, '应当拿到 ApiVersion')
  assert.equal(handshake.osType, 'linux')

  const containers = await client.listContainers()
  assert.ok(Array.isArray(containers))
  // 负对照：管道名写错 → 这里会抛 CONNECT_FAILED
})

test('真机：连接 + exec + 文件操作全链路', { skip }, async () => {
  const transport = new DockerTransport({ container: CONTAINER })
  await transport.connect()
  try {
    assert.equal(transport.connected, true)
    assert.ok(transport.capabilities.shell, '容器应当有 shell')

    // 准备沙箱
    const setup = await transport.exec(`rm -rf ${SANDBOX} && mkdir -p ${SANDBOX}/sub && echo READY`)
    assert.equal(setup.code, 0, `准备沙箱失败：${setup.stderr}`)
    assert.match(setup.stdout, /READY/)

    // exec：命令真的在 Linux 容器里跑
    const uname = await transport.exec('uname -s && id -un')
    assert.equal(uname.code, 0)
    assert.match(uname.stdout, /Linux/)

    // cwd
    const pwd = await transport.exec('pwd', { cwd: '/' })
    assert.equal(pwd.stdout.trim(), '/', `WorkingDir 没生效：${pwd.stdout}`)

    // env
    const env = await transport.exec('echo "FOO=$FOO"', { env: { FOO: 'bar' } })
    assert.match(env.stdout, /FOO=bar/)

    // 非零退出码如实回报
    assert.equal((await transport.exec('exit 7')).code, 7)

    // stdout / stderr 分离（多路复用流解析）
    const split = await transport.exec('echo OUT; echo ERR 1>&2')
    assert.equal(split.stdout.trim(), 'OUT')
    assert.equal(split.stderr.trim(), 'ERR')

    // ── 原子写 + 读回（含中文） ────────────────────────────────────────
    const file = `${SANDBOX}/hello.txt`
    const content = '你好，容器\nsecond line\n'
    await transport.writeFileAtomic(file, content)
    assert.equal(await transport.readFile(file, { encoding: 'utf8' }), content)

    // 覆盖写
    await transport.writeFileAtomic(file, 'overwritten\n')
    assert.equal(await transport.readFile(file, { encoding: 'utf8' }), 'overwritten\n')

    // stat
    const info = await transport.stat(file)
    assert.equal(info.type, 'file')
    assert.equal(info.size, Buffer.byteLength('overwritten\n', 'utf8'))
    assert.ok(info.mtimeMs > 1_600_000_000_000, `mtime 应当是毫秒：${info.mtimeMs}`)

    // readdir
    await transport.writeFileAtomic(`${SANDBOX}/sub/a.js`, 'const a = 1\n')
    const entries = await transport.readdir(`${SANDBOX}/sub`)
    assert.deepEqual(entries.map((entry) => entry.name), ['a.js'])
    assert.equal(entries[0].type, 'file')

    // realpath
    assert.equal(await transport.realpath(SANDBOX), SANDBOX)

    // 不存在 → NOT_FOUND
    await assert.rejects(
      () => transport.readFile(`${SANDBOX}/nope.txt`),
      (error) => error.code === TRANSPORT_ERROR.NOT_FOUND,
    )

    // maxBytes 硬上限
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

test('真机：archive 端点在二进制文件上按字节保真', { skip }, async () => {
  const transport = new DockerTransport({ container: CONTAINER })
  await transport.connect()
  try {
    await transport.exec(`rm -rf ${SANDBOX} && mkdir -p ${SANDBOX}`)
    // 造一个含 NUL 与 0xff 的二进制文件（用 printf 精确控制字节）
    const made = await transport.exec(`printf '\\000\\377\\020\\200\\012' > ${SANDBOX}/bin.dat`)
    assert.equal(made.code, 0)

    const bytes = await transport.readFile(`${SANDBOX}/bin.dat`)
    assert.ok(Buffer.isBuffer(bytes), '不传 encoding 应当返回 Buffer')
    assert.deepEqual([...bytes], [0x00, 0xff, 0x10, 0x80, 0x0a])
    // 负对照：走 exec + base64 时若用 UTF-8 往返，0xff 会被改坏
  } finally {
    await transport.exec(`rm -rf ${SANDBOX}`).catch(() => {})
    await transport.disconnect()
  }
})

test('真机：符号链接语义', { skip }, async () => {
  const transport = new DockerTransport({ container: CONTAINER })
  await transport.connect()
  try {
    await transport.exec(`rm -rf ${SANDBOX} && mkdir -p ${SANDBOX}/real && echo target > ${SANDBOX}/real/f.txt && ln -sf real/f.txt ${SANDBOX}/link.txt`)

    const entries = await transport.readdir(SANDBOX)
    const link = entries.find((entry) => entry.name === 'link.txt')
    assert.ok(link, '应当能看到符号链接')
    assert.equal(link.type, 'symlink')

    assert.equal(await transport.realpath(`${SANDBOX}/link.txt`), `${SANDBOX}/real/f.txt`)
    assert.equal(await transport.readFile(`${SANDBOX}/link.txt`, { encoding: 'utf8' }), 'target\n')
    // 负对照：archive 的 tar 头不区分符号链接时，readdir 会把 link 当成普通文件
  } finally {
    await transport.exec(`rm -rf ${SANDBOX}`).catch(() => {})
    await transport.disconnect()
  }
})

test('真机：多路复用流解析（真实 exec 输出）', { skip }, async () => {
  const client = new DockerClient()
  await client.handshake()
  const execId = await client.createExec(CONTAINER, {
    Cmd: ['sh', '-c', 'echo STDOUT-MARK; echo STDERR-MARK 1>&2; exit 3'],
    AttachStdout: true,
    AttachStderr: true,
  })
  const started = await client.startExec(execId)
  const frames = parseMultiplexed(started.body)

  const stdout = frames.filter((f) => f.streamType === 1).map((f) => f.data.toString('utf8')).join('')
  const stderr = frames.filter((f) => f.streamType === 2).map((f) => f.data.toString('utf8')).join('')
  assert.match(stdout, /STDOUT-MARK/)
  assert.match(stderr, /STDERR-MARK/)

  const inspected = await client.inspectExec(execId)
  assert.equal(inspected.value.ExitCode, 3)
  // 负对照：把整条流当纯文本 → 输出里混进 8 字节二进制头，断言全失败
})
