/**
 * SSH **断线重连**的真机验证。
 *
 * ## 为什么要真起一个服务端
 *
 * 假客户端能验证「重连逻辑的分支」，但验证不了**真的断线长什么样**：
 * 服务端关闭时客户端到底收到什么事件、`dead` 有没有被置上、
 * 重连时 host key 校验会不会误报、认证会不会重来一遍 ——
 * 这些都只有真的握手一次才知道。
 *
 * 用 `ssh2` 自带的 `Server` 在进程内起一个真 SSH 服务端，所以这个测试
 * **不需要外部靶机、不需要网络、不需要 Docker**，clone 下来就能跑。
 *
 * ## 为什么这比 Docker 夹具更好
 *
 * Docker 夹具要先拉镜像（依赖 registry 可用）；这个纯进程内，
 * 而且能**精确控制断线时机**（关服务端就是断线）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import ssh2 from 'ssh2'

import { SshTransport, KnownHosts } from '../src/transport/ssh.js'
import { TRANSPORT_ERROR } from '../src/transport/transport.js'

const { Server, utils } = ssh2

/** 服务端主机密钥（每次测试生成一把，避免把密钥写进仓库）。 */
let hostKey
function getHostKey() {
  hostKey ??= utils.generateKeyPairSync('ed25519').private
  return hostKey
}

/**
 * 起一个真 SSH 服务端。
 *
 * ⚠️ `close()` 会**显式销毁所有活连接**：Node 的 `server.close()` 只停止接受新连接，
 * 然后**等已有连接结束** —— 客户端还连着的话它会一直不回调（实测踩到，测试直接挂死）。
 * 我们要的语义是「服务端没了」，所以主动断开。
 *
 * @returns {Promise<{ port: number, server: import('ssh2').Server, close: () => Promise<void>, connections: () => number }>}
 */
async function startSshServer() {
  const state = { connections: 0 }
  /** @type {Set<{ end: () => void, destroy?: () => void }>} */
  const live = new Set()

  const server = new Server({ hostKeys: [getHostKey()] }, (client) => {
    state.connections += 1
    live.add(client)
    client.on('close', () => live.delete(client))
    client.on('authentication', (auth) => {
      // 只认「任意用户名 + 任意密码」，够我们验证链路
      if (auth.method === 'password') auth.accept()
      else auth.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _rejectExec, info) => {
          const stream = acceptExec()
          // 极简「shell」：把命令回显出来，退出码 0
          stream.write(`RAN:${info.command}\n`)
          stream.exit(0)
          stream.end()
        })
        session.on('pty', (accept) => accept?.())
        session.on('shell', (accept) => {
          const stream = accept()
          stream.write('WELCOME\n')
        })
      })
    })
    client.on('error', () => {})
  })

  // 注意：`server.on('connection')` 给的是 ssh2 的 Client（不是裸 socket），
  // 所以用它的 `end()` 断开 —— 别想着 `socket.destroy()`（没有这个方法，实测报错）
  server.on('connection', (client) => {
    live.add(client)
    client.on('close', () => live.delete(client))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  return {
    port,
    server,
    connections: () => state.connections,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        for (const client of live) {
          try {
            client.end()
          } catch {
            // 已经断了
          }
        }
        live.clear()
      }),
  }
}

/** 造一个连到给定端口的 transport（用密码认证，免去密钥文件）。 */
function transportFor(port) {
  const transport = new SshTransport({
    host: '127.0.0.1',
    port,
    username: 'tester',
    password: 'pw',
    knownHosts: new KnownHosts(),
    // ⚠️ `onHostKey` 是**通知回调**，不是「信任决定」：它的存在让未知密钥走 TOFU
    // （`verifyHostKey` 里会 `remember`）。不给它、又没预置 known_hosts 时会**拒绝**连接
    // —— 那是刻意的「宁可拒绝也不静默接受陌生密钥」。
    onHostKey: () => {},
    readyTimeoutMs: 5000,
    execTimeoutMs: 5000,
  })
  return transport
}

// ── 真机：基础链路先得对 ────────────────────────────────────────────────────

test('真机：能连上进程内的 SSH 服务端并执行命令', async () => {
  const srv = await startSshServer()
  const transport = transportFor(srv.port)
  try {
    await transport.connect()
    assert.equal(transport.hasConnected, true, '连上后应当记住「连过」')
    const result = await transport.exec('echo hi')
    assert.equal(result.code, 0)
    assert.match(result.stdout, /RAN:echo hi/, '应当拿到服务端的输出')
  } finally {
    await transport.disconnect().catch(() => {})
    await srv.close()
  }
  // 负对照：连不上就说明测试脚手架本身有问题，后面的重连结论也不可信
})

// ── 真机：断线 → 自动重连 ──────────────────────────────────────────────────

test('真机：服务端断开后，下一个操作自动重连并成功', async () => {
  const srv = await startSshServer()
  const transport = transportFor(srv.port)
  try {
    await transport.connect()
    assert.match((await transport.exec('before')).stdout, /RAN:before/)

    // **真的**断线：关掉服务端
    await srv.close()
    // 等客户端察觉（TCP 关闭 → ssh2 的 close 事件）
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(transport.dead, true, '服务端关掉后客户端应当标记通道已死')

    // 同一个端口重新起服务端（模拟「服务端重启」）
    const srv2 = await startSshServer()
    try {
      // 端口不同 → 把 transport 指向新端口（真实场景里端口不变，是服务端重启；
      // 这里为了让测试稳定用新端口，重连逻辑本身与端口无关）
      transport.port = srv2.port

      const result = await transport.exec('after')
      assert.equal(result.code, 0, '重连之后应当成功')
      assert.match(result.stdout, /RAN:after/)
      assert.equal(transport.reconnects, 1, '应当自动重连过一次')
    } finally {
      await srv2.close()
    }
  } finally {
    await transport.disconnect().catch(() => {})
  }
  // 负对照：不重连 → 服务端重启一次之后，用户得手动重连整个工作区
})

test('真机：重连时 host key 校验仍然生效（不会因为重连就放行）', async () => {
  const srv = await startSshServer()
  const seen = []
  const transport = transportFor(srv.port)
  transport.onHostKey = (info) => {
    seen.push(info)
  }
  try {
    await transport.connect()
    assert.equal(seen.length, 1, '首次连接应当校验一次 host key')

    await srv.close()
    await new Promise((resolve) => setTimeout(resolve, 300))

    const srv2 = await startSshServer()
    try {
      transport.port = srv2.port
      await transport.exec('after')
      assert.equal(seen.length, 2, '重连也应当再走一次 host key 校验')
      // 两次都是「首次见到」（端口变了 → 是不同的 known_hosts 条目）→ 走 TOFU
      assert.equal(seen[1].result, 'unknown', '新端口上是首次见到 → unknown → TOFU 记住')
      assert.ok(typeof seen[1].fingerprint === 'string' && seen[1].fingerprint.length > 0)
    } finally {
      await srv2.close()
    }
  } finally {
    await transport.disconnect().catch(() => {})
  }
  // 负对照：重连跳过校验 → 攻击者只要等断线就能冒充服务端（这是安全红线）
})

test('真机：没有信任回调时，陌生主机密钥一律拒绝（不静默接受）', async () => {
  const srv = await startSshServer()
  const transport = new SshTransport({
    host: '127.0.0.1',
    port: srv.port,
    username: 'tester',
    password: 'pw',
    knownHosts: new KnownHosts(),
    // 刻意**不给** onHostKey
    readyTimeoutMs: 5000,
  })
  try {
    await assert.rejects(
      () => transport.connect(),
      (error) => {
        assert.equal(error.code, TRANSPORT_ERROR.HOST_KEY_MISMATCH)
        assert.match(error.message, /首次连接/)
        return true
      },
    )
  } finally {
    await transport.disconnect().catch(() => {})
    await srv.close()
  }
  // 负对照：没有回调就默认信任 → 第一次连谁都不知道，中间人直接得手
})

test('真机：**从没连过**时调操作不会静默建立连接', async () => {
  const srv = await startSshServer()
  const transport = transportFor(srv.port)
  try {
    // 注意：**不调用 connect()**
    assert.equal(transport.hasConnected, false)
    await assert.rejects(
      () => transport.exec('echo hi'),
      (error) => error.code === TRANSPORT_ERROR.NOT_CONNECTED,
    )
    assert.equal(srv.connections(), 0, '服务端不该收到任何连接')
    assert.equal(transport.reconnects, 0)
  } finally {
    await transport.disconnect().catch(() => {})
    await srv.close()
  }
  // 负对照：自动重连不检查 hasConnected → 用户没下连接指令，却静默连上了一台机器
})

test('真机：连不上的时候重连也失败，且报的是「连不上」的原因', async () => {
  // 先占一个端口再立刻释放，保证这个端口上没有服务端
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const deadPort = probe.address().port
  await new Promise((resolve) => probe.close(resolve))

  const transport = transportFor(deadPort)
  await assert.rejects(
    () => transport.connect(),
    (error) => {
      // 连不上就是连不上 —— 不该报成别的类别
      assert.ok(
        [TRANSPORT_ERROR.CONNECT_FAILED, TRANSPORT_ERROR.TIMEOUT].includes(error.code),
        `实际：${error.code} ${error.message}`,
      )
      return true
    },
  )
  // 负对照：把「连不上」报成 UNKNOWN → 用户不知道该检查网络还是检查配置
})
