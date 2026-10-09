/**
 * `src/transport/ssh.js` 的契约测试。
 *
 * 分两层：
 *   1. **纯逻辑**（命令包装、shell 转义、host key 判定）—— 不连网，人人可跑。
 *   2. **端到端**（真连一台 SSH 服务器）—— 只在显式给了环境变量时才跑，
 *      因为外部贡献者没有我们的靶机，默认跑会让 `node --test` 变红。
 *
 *      启用方式：
 *        DSH_MR_SSH_TEST=1 DSH_MR_SSH_HOST=... DSH_MR_SSH_PORT=... \
 *        DSH_MR_SSH_USER=... DSH_MR_SSH_KEY=<私钥路径> node --test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { SshTransport, KnownHosts, HOST_KEY_RESULT, wrapCommand, shellQuote, fingerprintFromKnownHostsKey, toFingerprint } from '../src/transport/ssh.js'
import { TRANSPORT_ERROR, TransportError, assertNoNul } from '../src/transport/transport.js'

// ── 1. 纯逻辑 ────────────────────────────────────────────────────────────────

test('shellQuote：POSIX 单引号转义，单引号也能安全表达', () => {
  assert.equal(shellQuote('simple'), "'simple'")
  assert.equal(shellQuote('/home/user/proj'), "'/home/user/proj'")
  // 这是唯一不依赖外部工具的做法
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  assert.equal(shellQuote(''), "''")
  // 危险字符必须被关在引号里
  assert.equal(shellQuote('a; rm -rf /'), "'a; rm -rf /'")
  assert.equal(shellQuote('$(whoami)'), "'$(whoami)'")
  assert.equal(shellQuote('`id`'), "'`id`'")
  // 负对照：用双引号包裹，`$(whoami)` 会被 shell 求值 —— 命令注入
})

test('wrapCommand：cwd 与 env 被包进命令（SSH exec 不认这两个字段）', () => {
  assert.equal(wrapCommand('ls', undefined, undefined), 'ls')
  assert.equal(wrapCommand('ls', '/tmp', undefined), "cd '/tmp' && ls")
  assert.equal(wrapCommand('ls', undefined, { A: '1' }), "A='1' ls")
  assert.equal(wrapCommand('ls', '/tmp', { A: '1', B: 'x y' }), "cd '/tmp' && A='1' B='x y' ls")
  // 负对照：直接把 cwd 丢掉，第一条带 cwd 的断言会失败
})

test('wrapCommand：cwd 里的单引号不会破坏命令结构', () => {
  const wrapped = wrapCommand('pwd', "/tmp/it's here", undefined)
  assert.equal(wrapped, `cd '/tmp/it'\\''s here' && pwd`)
  // 负对照：不做转义会得到 `cd '/tmp/it's here' && pwd` —— shell 解析直接崩
})

test('assertNoNul：NUL 字节必须被挡住（服务端只报 invalid format）', () => {
  assert.doesNotThrow(() => assertNoNul('echo hi', '命令'))
  assert.throws(() => assertNoNul('echo \0hi', '命令'), TransportError)
  assert.throws(() => assertNoNul('echo \0hi', '命令'), /NUL/)
  // 负对照：不挡 NUL，服务端返回的错误完全指不到原因
})

test('KnownHosts：一致放行、首次未知、不一致必须拒绝', () => {
  const hosts = new KnownHosts()
  const fp = 'abc123'
  assert.equal(hosts.verify('h', 22, fp).result, HOST_KEY_RESULT.UNKNOWN)

  hosts.remember('h', 22, fp)
  assert.equal(hosts.verify('h', 22, fp).result, HOST_KEY_RESULT.MATCH)

  const verdict = hosts.verify('h', 22, 'different')
  assert.equal(verdict.result, HOST_KEY_RESULT.MISMATCH)
  assert.equal(verdict.known, fp, '不一致时要能说出期望值')

  // 端口必须参与：同机不同端口不能互相污染
  assert.equal(hosts.verify('h', 2222, fp).result, HOST_KEY_RESULT.UNKNOWN)
  // 负对照：键只用 host 不含 port，上面这条会返回 MATCH
})

test('KnownHosts：base64 填充不影响比较', () => {
  const hosts = new KnownHosts()
  hosts.remember('h', 22, 'abc=')
  assert.equal(hosts.verify('h', 22, 'abc').result, HOST_KEY_RESULT.MATCH)
  // 负对照：不做去填充，同一密钥会因 `=` 被判为不一致 → 用户被挡在门外
})

test('fingerprintFromKnownHostsKey：能算出与 ssh2 一致的标准指纹', () => {
  // 自造一个 blob，验证算法（sha256 of blob，base64 去填充）
  const blob = Buffer.from('not-a-real-key-just-bytes')
  const expected = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  assert.equal(fingerprintFromKnownHostsKey(blob.toString('base64')), expected)
  // 负对照：算成 sha1（老格式）就对不上 ssh2 给的 sha256 指纹
})

test('SshTransport：没有信任回调时，陌生主机一律拒绝', async () => {
  const transport = new SshTransport({ host: 'example.invalid', username: 'x' })
  // 直接调校验逻辑：首次见到且无人确认 → 必须抛错，不能默认信任
  assert.throws(
    () => transport.verifyHostKey('brand-new-fingerprint'),
    (error) => {
      assert.equal(error.code, TRANSPORT_ERROR.HOST_KEY_MISMATCH)
      assert.match(error.message, /首次连接/)
      return true
    },
  )
  // 负对照：返回 true 默认信任，就是静默接受陌生密钥 —— MITM 的入口
})

test('SshTransport：host key 不一致时拒绝，并给出期望值', () => {
  const hosts = new KnownHosts()
  hosts.remember('example.invalid', 22, 'expected-fp')
  const transport = new SshTransport({ host: 'example.invalid', port: 22, username: 'x', knownHosts: hosts })

  assert.throws(
    () => transport.verifyHostKey('attacker-fp'),
    (error) => {
      assert.equal(error.code, TRANSPORT_ERROR.HOST_KEY_MISMATCH)
      assert.equal(error.retryable, false)
      assert.match(error.message, /中间人/)
      assert.match(error.message, /expected-fp/, '必须告诉用户期望的指纹')
      return true
    },
  )
  // 负对照：不一致时只写日志放行 —— 这正是 MITM 能成功的形态
})

test('SshTransport：onHostKey 抛错即拒绝连接', () => {
  const transport = new SshTransport({
    host: 'example.invalid',
    username: 'x',
    onHostKey: () => {
      throw new Error('用户拒绝了这把密钥')
    },
  })
  assert.throws(() => transport.verifyHostKey('fp'), /用户拒绝了这把密钥/)
  // 负对照：忽略回调的抛错，TOFU 的「拒绝」就失效了
})

test('SshTransport：已知主机匹配时放行且不重复记录', () => {
  const keyBytes = Buffer.from('another-fake-host-key', 'utf8')
  const digestHex = createHash('sha256').update(keyBytes).digest('hex')
  const digestBase64 = createHash('sha256').update(keyBytes).digest('base64').replace(/=+$/, '')

  const hosts = new KnownHosts()
  hosts.remember('example.invalid', 22, digestBase64)
  const seen = []
  const transport = new SshTransport({
    host: 'example.invalid',
    port: 22,
    username: 'x',
    knownHosts: hosts,
    onHostKey: (info) => seen.push(info),
  })

  // ssh2 在 hostHash 模式下给的就是这个 hex 摘要
  assert.equal(transport.verifyHostKey(digestHex), true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].result, HOST_KEY_RESULT.MATCH)
  assert.equal(seen[0].fingerprint, digestBase64, '回调拿到的是与 known_hosts 同格式的指纹')
  // 负对照：把 hex 当原始密钥再哈希一次，这里会判成 MISMATCH 并抛错
})

test('SshTransport：未连接时操作立刻失败（不各等满超时）', async () => {
  const transport = new SshTransport({ host: 'example.invalid', username: 'x' })
  await assert.rejects(() => transport.stat('/x'), (error) => {
    assert.equal(error.code, TRANSPORT_ERROR.NOT_CONNECTED)
    return true
  })
  await assert.rejects(() => transport.readdir('/x'), (error) => error.code === TRANSPORT_ERROR.NOT_CONNECTED)
  // 负对照：不检查连接状态，每个操作会等满超时才失败 → N 个条目 = 永远跑不完
})

test('SshTransport：已取消的 signal 直接抛 ABORTED，不发请求', async () => {
  const transport = new SshTransport({ host: 'example.invalid', username: 'x' })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => transport.realpath('/x', { signal: controller.signal }),
    (error) => {
      assert.equal(error.code, TRANSPORT_ERROR.ABORTED)
      return true
    },
  )
  // 负对照：不看 signal，取消后还会真的去发一次 SFTP 请求
})

test('SshTransport：disconnect 幂等，重复调用不抛错', async () => {
  const transport = new SshTransport({ host: 'example.invalid', username: 'x' })
  await transport.disconnect()
  await transport.disconnect()
  // 负对照：disconnect 里不判空，第二次会 TypeError
})

// ── 2. 端到端（只在显式配置了靶机时运行） ────────────────────────────────────

const e2e = process.env.DSH_MR_SSH_TEST === '1'
const e2eConfig = {
  host: process.env.DSH_MR_SSH_HOST,
  port: Number(process.env.DSH_MR_SSH_PORT ?? 22),
  username: process.env.DSH_MR_SSH_USER,
  privateKeyPath: process.env.DSH_MR_SSH_KEY,
}
const e2eSandbox = process.env.DSH_MR_SSH_SANDBOX ?? '/tmp/dsh-multi-remote-e2e'

/**
 * 这个路径看起来像个**专用沙箱**吗？不是就拒绝删除。
 *
 * 端到端测试要先把沙箱清空，而那是在**别人的真机器**上执行 `rm -rf`。
 * 光靠「测试代码写对了」不够 —— `DSH_MR_SSH_SANDBOX=/` 一个手误就能删根目录。
 * 所以先做一次形状检查：必须在 `/tmp/` 下，且不是 `/tmp/` 本身。
 */
function isSafeSandbox(path) {
  const normalized = String(path).replace(/\/+$/, '')
  return normalized.startsWith('/tmp/') && normalized.length > '/tmp/'.length
}

/**
 * 把沙箱恢复成**空目录**。
 *
 * ⚠️ 这里踩过一个真 bug（只有真靶机才暴露）：
 * 原来写的是 `rm -rf ${shellQuote(`${e2eSandbox}/*`)}` ——
 * `shellQuote` 会把**通配符也引号包起来**，发出去的是
 * `rm -rf '/tmp/x/*'`，远程 shell 收到字面量 `*` → **什么都没删**。
 * 夹具是「每次新容器」，沙箱天然是空的，所以这条一直装作通过了；
 * 真靶机上有上次的残留，`readdir` 立刻对不上。
 *
 * 正确做法是删**目录本身**再重建（顺带也解决了 `*` 匹配不到点文件的问题）。
 */
function sandboxResetCommand() {
  assert.ok(isSafeSandbox(e2eSandbox), `沙箱路径不像专用沙箱，拒绝删除：${e2eSandbox}`)
  return `rm -rf ${shellQuote(e2eSandbox)} && mkdir -p ${shellQuote(e2eSandbox)}`
}

/**
 * 真靶机的终端输出会被**折行**，正则跨行匹配会失败。
 *
 * 夹具（alpine）没有 banner，测试里也全是 ASCII，所以看不出问题；
 * 真靶机有中文 motd（宽字符）+ 很长的 unattended-upgrades 提示，
 * `TTY=/dev/pts/0` 这种短字符串都可能正好被折在行尾。
 * 所以匹配前先把换行去掉。
 */
function flatten(viewport) {
  return String(viewport).replace(/[\r\n]/g, '')
}

/**
 * 端到端测试。**刻意把读写限制在一个专用沙箱目录里** ——
 * 靶机可能是别人在用的真机器，不能到处乱写。
 */
test('toFingerprint：ssh2 的两种输入形态都归一成 sha256 base64', () => {
  const keyBytes = Buffer.from('a-fake-ssh-host-key-for-testing-only', 'utf8')
  const digestBase64 = createHash('sha256').update(keyBytes).digest('base64').replace(/=+$/, '')
  const digestHex = createHash('sha256').update(keyBytes).digest('hex')

  // 形态 1：原始密钥字节（没设 hostHash 时 ssh2 传这个）
  assert.equal(toFingerprint(keyBytes, 'raw'), digestBase64)

  // 形态 2：**摘要的 hex 编码**（设了 hostHash: 'sha256' 时 ssh2 传这个）
  // 关键：只能重新编码，绝不能再哈希一次。
  assert.equal(toFingerprint(digestHex), digestBase64)

  // 负对照 A：拿 hex 当原始密钥去哈希 → 得到一个完全不同的值
  assert.notEqual(
    createHash('sha256').update(Buffer.from(digestHex, 'hex')).digest('base64').replace(/=+$/, ''),
    digestBase64,
  )
  // 负对照 B：对 hex 字符串再哈希一次 → 同样不同
  assert.notEqual(
    createHash('sha256').update(digestHex).digest('base64').replace(/=+$/, ''),
    digestBase64,
  )
  // 这两个负对照就是实测踩过的两次真实 bug（每次连接都误报「中间人攻击」）
})

test('toFingerprint：真实靶机的已知指纹能被还原出来（回归用例）', () => {
  // 实测值：ssh2 在 hostHash: 'sha256' 下给出的 hex，与 known_hosts 里的 base64
  const digestHex = '99ae4474d8961b15b14b0888304d4eb4590e32a9a44f16b1e4995eb1179643dc'
  const knownHostsFingerprint = 'ma5EdNiWGxWxSwiIME1OtFkOMqmkTxax5JlesReWQ9w'
  assert.equal(toFingerprint(digestHex), knownHostsFingerprint)
  // 负对照：这条用例锁住真实格式；改动 toFingerprint 的语义会立刻变红
})

test('toFingerprint 与 known_hosts 的指纹格式一致（端到端格式契约）', () => {
  // known_hosts 里存的是 base64 的密钥 blob；ssh2 给的是原始密钥或摘要 hex。
  // 两者算出来的指纹必须落在同一个格式上，否则 TOFU 永远匹配不上。
  const keyBlob = Buffer.from([0x00, 0x00, 0x00, 0x0b, 0x73, 0x73, 0x68, 0x2d, 0x65, 0x64, 0x32, 0x35, 0x35, 0x31, 0x39, 0x01, 0x02])
  const fromKnownHosts = fingerprintFromKnownHostsKey(keyBlob.toString('base64'))
  assert.equal(toFingerprint(keyBlob, 'raw'), fromKnownHosts, '原始密钥形态必须与 known_hosts 算出同一个指纹')
  const digestHex = createHash('sha256').update(keyBlob).digest('hex')
  assert.equal(toFingerprint(digestHex), fromKnownHosts, '摘要 hex 形态也必须算出同一个指纹')
  // 负对照：两边格式不一致时，TOFU 永远判定为 MISMATCH
})

test('端到端：连接、exec、SFTP 读写、原子写', { skip: e2e ? false : '未设置 DSH_MR_SSH_TEST=1（外部贡献者没有靶机）' }, async () => {
  const privateKey = await readFile(e2eConfig.privateKeyPath, 'utf8')
  const transport = new SshTransport({
    host: e2eConfig.host,
    port: e2eConfig.port,
    username: e2eConfig.username,
    privateKey,
    // 首次连接：接受并记录（真实产品里这一步要用户确认）
    onHostKey: () => {},
  })

  await transport.connect()
  try {
    // exec：命令真的在远程跑
    const whoami = await transport.exec('id -un && hostname')
    assert.equal(whoami.code, 0, `exec 失败：${whoami.stderr}`)
    assert.match(whoami.stdout, new RegExp(e2eConfig.username), '命令应当在远程以该账号执行')

    // cwd 包装生效
    const pwd = await transport.exec('pwd', { cwd: '/' })
    assert.equal(pwd.stdout.trim(), '/', `cwd 没生效：${pwd.stdout}`)

    // 非零退出码要如实回报，而不是抛错
    const failed = await transport.exec('exit 42')
    assert.equal(failed.code, 42)

    // 超时要被分类，而不是挂死
    await assert.rejects(
      () => transport.exec('sleep 10', { timeoutMs: 700 }),
      (error) => error.code === TRANSPORT_ERROR.TIMEOUT,
    )

    // 准备沙箱目录（删目录本身再重建 —— 见 sandboxResetCommand 的注释）
    const setup = await transport.exec(sandboxResetCommand())
    assert.equal(setup.code, 0, `建沙箱失败：${setup.stderr}`)

    // 原子写 + 读回
    const file = `${e2eSandbox}/hello.txt`
    await transport.writeFileAtomic(file, '你好，远程\n')
    assert.equal(await transport.readFile(file, { encoding: 'utf8' }), '你好，远程\n')

    // 原子写覆盖已存在文件（SFTP rename 不覆盖，实现里先 unlink）
    await transport.writeFileAtomic(file, 'second\n')
    assert.equal(await transport.readFile(file, { encoding: 'utf8' }), 'second\n')

    // stat
    const info = await transport.stat(file)
    assert.equal(info.type, 'file')
    assert.equal(info.size, Buffer.byteLength('second\n', 'utf8'))
    assert.ok(info.mtimeMs > 1_600_000_000_000, `mtime 应是毫秒：${info.mtimeMs}`)

    // readdir
    const entries = await transport.readdir(e2eSandbox)
    assert.deepEqual(entries.map((entry) => entry.name), ['hello.txt'])

    // 不存在的文件要分类成 NOT_FOUND
    await assert.rejects(
      () => transport.readFile(`${e2eSandbox}/nope.txt`),
      (error) => error.code === TRANSPORT_ERROR.NOT_FOUND,
    )

    // maxBytes 是硬上限，超过要失败而不是截断
    await assert.rejects(
      () => transport.readFile(file, { maxBytes: 2 }),
      (error) => error.code === TRANSPORT_ERROR.TOO_LARGE,
    )

    // realpath
    assert.equal(await transport.realpath(e2eSandbox), e2eSandbox)
  } finally {
    await transport.exec(`rm -rf ${shellQuote(e2eSandbox)}`).catch(() => {})
    await transport.disconnect()
  }
})

test('端到端：密码错误要分类成 AUTH_FAILED，而不是笼统失败', { skip: e2e ? false : '未设置 DSH_MR_SSH_TEST=1' }, async () => {
  const transport = new SshTransport({
    host: e2eConfig.host,
    port: e2eConfig.port,
    username: e2eConfig.username,
    // 一个格式合法但一定不对的私钥
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n',
    onHostKey: () => {},
  })
  const result = await transport.testConnection()
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_ERROR.AUTH_FAILED, `实际：${result.code} ${result.detail}`)
  // 负对照：不分类的话调用方只能拿到一句英文原文，没法给出可执行提示
})

// ── 端到端：交互式终端 ──────────────────────────────────────────────────────

test('端到端：SSH 交互式终端（真 PTY、状态持久、信号、resize）', { skip: e2e ? false : '未设置 DSH_MR_SSH_TEST=1' }, async () => {
  // 走**与插件完全相同**的那一层：RemoteTerminalBackend → transport.spawnTerminal。
  // 这条补的是 R-0005 遗留 1（SSH 终端原先没有真机验证）。
  const { RemoteTerminalBackend } = await import('../src/terminal/backend.js')
  const transport = new SshTransport({
    host: e2eConfig.host,
    port: e2eConfig.port,
    username: e2eConfig.username,
    privateKey: await readFile(e2eConfig.privateKeyPath, 'utf8'),
    onHostKey: () => {},
  })
  await transport.connect()

  // 单独跑这个测试时沙箱可能不存在（上一个测试的 finally 会删掉它）
  const ensure = await transport.exec(sandboxResetCommand())
  assert.equal(ensure.code, 0, `建沙箱失败：${ensure.stderr}`)

  const backend = new RemoteTerminalBackend({ transport, label: 'e2e', cwd: e2eSandbox })
  const session = await backend.spawn({ sessionId: 'pty-1', type: backend.type, cwd: e2eSandbox })

  /** 取滚动缓冲里最后一个「看起来像命令输出」的行。 */
  const lastLine = (viewport, pattern) => {
    const lines = viewport.split('\n').map((line) => line.replace(/\r$/, '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim())
    return [...lines].reverse().find((line) => pattern.test(line)) ?? null
  }

  try {
    const send = (text, timeoutMs = 15_000) => session.startSend({ text, submit: true, timeoutMs }).done

    assert.equal(session.status().kind, 'running')

    // 1) 基础交互
    const basic = await send('echo SSH-TERM-OK')
    assert.match(basic.viewport, /SSH-TERM-OK/, '终端应当能执行命令并回显')

    // 2) 真 PTY（不是管道）
    //    匹配前 flatten：真靶机的输出会被折行，`TTY=/dev/pts/0` 可能被折在行尾
    const ttyResult = await send('echo "TTY=$(tty)"')
    const tty = /TTY=(\/dev\/pts\/\d+)/.exec(flatten(ttyResult.viewport))?.[1]
    assert.ok(tty !== undefined, `应当能拿到 tty，实际输出：${ttyResult.viewport.slice(-200)}`)
    assert.ok(tty.startsWith('/dev/pts'), `必须是真 PTY（/dev/pts/N），实际：${tty}`)
    // 负对照：用 exec 通道假装终端 → tty 会报 "not a tty"，sudo/密码输入全废

    // 3) 状态跨调用保留
    await send(`cd ${e2eSandbox}`)
    const pwdAgain = await send('pwd')
    assert.match(flatten(pwdAgain.viewport), new RegExp(e2eSandbox.replace(/[/\\]/g, '.')), 'cwd 应当跨调用保留')
    // 负对照：每次都是新 shell → cd 丢失，用户得在每条命令里重复 cd

    // 4) resize 真的生效（SSH 原生支持 setWindow）
    session.resize(120, 40)
    const sized = await send('echo "SIZE=$(stty size)"')
    assert.match(flatten(sized.viewport), /SIZE=40 120/, `resize 应当生效（期望 40 120），实际：${lastLine(sized.viewport, /SIZE=/) ?? sized.viewport.slice(-150)}`)
    // 负对照：不转发 setWindow → vim / top 这类全屏程序画错

    // 5) SIGINT 能打断前台命令
    const longRun = session.startSend({ text: 'sleep 30', submit: true, timeoutMs: 2500 })
    await new Promise((resolve) => setTimeout(resolve, 900))
    await session.signal('SIGINT')
    await longRun.done

    const t1 = Date.now()
    const after = await send('echo AFTER-INT', 6000)
    assert.match(after.viewport, /AFTER-INT/, 'SIGINT 之后 shell 应当立刻回来')
    assert.ok(Date.now() - t1 < 5000, `SIGINT 应当很快生效，实际 ${Date.now() - t1}ms`)
    // 负对照：信号没送到前台进程组 → sleep 继续占着终端，这条 echo 要等到超时

    // 6) read 分页
    const page = session.read({ offset: 0, count: 5 })
    assert.ok(page.totalLines > 0, '滚动缓冲应当有内容')

    // 7) close 幂等，且真的结束
    await session.close()
    await session.close()
    assert.equal(session.status().kind, 'exited', '关闭后状态应当是 exited')
    // 负对照：close 不幂等 → 重复关闭报错或重复杀进程
  } finally {
    await session.close().catch(() => {})
    // 清理也走安全闸（别因为一个环境变量手误就 rm -rf 到别处去）
    if (isSafeSandbox(e2eSandbox)) {
      await transport.exec(`rm -rf ${shellQuote(e2eSandbox)}`).catch(() => {})
    }
    await transport.disconnect()
  }
})
