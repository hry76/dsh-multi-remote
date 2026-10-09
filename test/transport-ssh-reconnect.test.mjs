/**
 * SSH 传输层的**断线重连**契约测试。
 *
 * ## 为什么需要
 *
 * SSH 是长连接：网络抖动、服务端重启 sshd、NAT 表项过期都会让通道断掉。
 * 断掉之后 `assertAlive` 会让每个操作立刻失败 —— 但**重连一下通常就好**，
 * 用户完全想不到「只是断过」（与 Docker 引擎重启是同一类问题）。
 *
 * ## 最关键的一条：区分「连过又断」与「从没连过」
 *
 * 这两种都是 `NOT_CONNECTED`，但处理方式**必须不同**：
 *
 * | 情况 | 该怎么做 |
 * |---|---|
 * | 连上过，后来断了 | 自动重连一次 |
 * | 用户根本没调用过 `connect()` | **绝不能偷偷连上去** |
 *
 * 第二种如果也自动重连，就等于「用户没让我们连，我们却静默建立了连接」——
 * 那比失败更坏，而且绕过了用户对「连哪台机器」的明确选择。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { SshTransport } from '../src/transport/ssh.js'
import { TRANSPORT_ERROR } from '../src/transport/transport.js'

/** 一个能跑完 `exec` 的假 channel。 */
function fakeChannel({ stdout = '', stderr = '', code = 0 } = {}) {
  const channel = new EventEmitter()
  channel.stderr = new EventEmitter()
  channel.close = () => {}
  channel.end = () => {}
  channel.write = () => {}
  // ⚠️ 注意：`#execImpl` 监听的是 **channel 自己** 的 `'data'`（不是 `channel.stdout`），
  // 只有 stderr 才走 `channel.stderr`。搞错这一点会得到「命令成功但输出为空」。
  setImmediate(() => {
    if (stdout !== '') channel.emit('data', Buffer.from(stdout, 'utf8'))
    if (stderr !== '') channel.stderr.emit('data', Buffer.from(stderr, 'utf8'))
    channel.emit('exit', code, undefined)
    channel.emit('close', code, undefined)
  })
  return channel
}

/** 一个假 ssh2 Client，`exec` 立刻回一个能跑完的 channel。 */
function fakeClient(options = {}) {
  return {
    exec(command, callback) {
      callback(undefined, fakeChannel(options))
    },
    end() {},
  }
}

/**
 * 造一个「已经连上过」的 transport（不真的握手）。
 *
 * @param {object} [options]
 * @param {boolean} [options.dead] 造出来就是死通道
 */
function connectedTransport(options = {}) {
  const transport = new SshTransport({ host: 'example.invalid', username: 'x' })
  transport.hasConnected = true
  transport.client = fakeClient()
  transport.dead = options.dead === true
  return transport
}

// ── 绝不偷偷连接 ────────────────────────────────────────────────────────────

test('重连：**从没连过**时绝不偷偷连上去', async () => {
  const transport = new SshTransport({ host: 'example.invalid', username: 'x' })
  assert.equal(transport.hasConnected, false)
  assert.equal(transport.client, undefined)

  let connectCalls = 0
  transport.connect = async () => {
    connectCalls += 1
    throw new Error('不该被调用')
  }

  await assert.rejects(
    () => transport.exec('echo hi'),
    (error) => error.code === TRANSPORT_ERROR.NOT_CONNECTED,
  )
  assert.equal(connectCalls, 0, '用户没让我们连，就绝不能连')
  assert.equal(transport.reconnects, 0)
  // 负对照：不看 hasConnected 就重连 → 用户没下连接指令，我们却静默建立了 SSH 连接
})

test('重连：连过又断 → 自动重连一次并成功', async () => {
  const transport = connectedTransport({ dead: true })

  let connectCalls = 0
  transport.connect = async () => {
    connectCalls += 1
    // 重连成功：通道恢复
    transport.client = fakeClient({ stdout: 'RECONNECTED' })
    transport.dead = false
  }

  const result = await transport.exec('echo hi')
  assert.equal(connectCalls, 1, '应当重连一次')
  assert.equal(transport.reconnects, 1)
  assert.equal(result.stdout.trim(), 'RECONNECTED', '重连后应当真的跑出结果')
  // 负对照：不重连 → 网络抖一下之后每个操作都失败，用户以为要重新配置
})

test('重连：只重试一次，不会无限循环', async () => {
  const transport = connectedTransport({ dead: true })

  let connectCalls = 0
  transport.connect = async () => {
    connectCalls += 1
    // 「重连」看起来成功，但通道立刻又死了
    transport.client = fakeClient()
    transport.dead = true
  }

  await assert.rejects(
    () => transport.exec('echo hi'),
    (error) => error.code === TRANSPORT_ERROR.NOT_CONNECTED,
  )
  assert.equal(connectCalls, 1, '只重连一次就放弃')
  assert.equal(transport.reconnects, 1)
  // 负对照：无限重试 → 目标真的下线时，一次失败被拖成长时间卡顿
})

test('重连：重连本身失败时，报**重连失败**的原因', async () => {
  const transport = connectedTransport({ dead: true })
  transport.connect = async () => {
    const { TransportError } = await import('../src/transport/transport.js')
    throw new TransportError(TRANSPORT_ERROR.AUTH_FAILED, '认证失败：密钥被拒绝', { operation: 'connect' })
  }

  await assert.rejects(
    () => transport.exec('echo hi'),
    (error) => {
      assert.equal(error.code, TRANSPORT_ERROR.AUTH_FAILED)
      assert.match(error.message, /密钥被拒绝/)
      return true
    },
  )
  // 负对照：报原始错误（「通道已死」）→ 用户不知道其实是凭据失效了
})

test('重连：**不**对「确定的结论」重试（命令里带 NUL 这类确定错误）', async () => {
  const transport = connectedTransport()
  let connectCalls = 0
  transport.connect = async () => {
    connectCalls += 1
  }

  // 命令里带 NUL 是**确定的**客户端侧错误（服务端只会回 "invalid format"，
  // 错误指不到原因）—— 重连一万次也不会变。
  await assert.rejects(
    () => transport.exec('echo \0 bad'),
    (error) => error.code !== TRANSPORT_ERROR.NOT_CONNECTED,
  )
  assert.equal(connectCalls, 0, '确定的结论不该重连')
  assert.equal(transport.reconnects, 0)
  // 负对照：什么都重试 → 同一个错误慢一倍才出现，还掩盖真正的问题
})

// ── assertAlive 必须是公开方法 ──────────────────────────────────────────────

test('assertAlive 是公开方法（终端后端要调它）', () => {
  const transport = new SshTransport({ host: 'example.invalid', username: 'x' })
  assert.equal(typeof transport.assertAlive, 'function', '必须是公开方法')
  // 实测踩到过：它原本叫 `#assertAlive`（私有），于是 `src/terminal/backends.js` 里写的
  // `transport.assertAlive?.()` 永远解析成 undefined —— 整个调用是死代码。
  // 负对照：改回私有 → 那边的检查静默失效，通道死了也走不到那条判定
})

test('assertAlive：死通道与未连接都抛 NOT_CONNECTED，且能自定义说明', () => {
  const never = new SshTransport({ host: 'example.invalid', username: 'x' })
  assert.throws(
    () => never.assertAlive(),
    (error) => error.code === TRANSPORT_ERROR.NOT_CONNECTED,
  )

  const dead = connectedTransport({ dead: true })
  assert.throws(
    () => dead.assertAlive('自定义说明'),
    (error) => {
      assert.equal(error.code, TRANSPORT_ERROR.NOT_CONNECTED)
      assert.equal(error.message, '自定义说明', '应当用调用方给的说明')
      return true
    },
  )

  // 活着的连接不该抛
  const alive = connectedTransport()
  assert.doesNotThrow(() => alive.assertAlive())
  // 负对照：三种情况一视同仁 → 活连接也被拒，或死通道静默放行
})

// ── 重连不能白等 ────────────────────────────────────────────────────────────

test('重连：死通道上 disconnect 不白等 2 秒兜底定时器', async () => {
  // 实测踩到过：重连时 `disconnect()` 会等 `close` 事件，但通道**早就死过**，
  // 那个事件已经触发完了 → 每次都白等满 2 秒兜底，重连因此慢 2.3 秒。
  const transport = new SshTransport({ host: 'example.invalid', username: 'x' })
  let endCalls = 0
  transport.client = {
    exec() {},
    end() {
      endCalls += 1
    },
  }
  transport.dead = true
  transport.hasConnected = true

  const t0 = Date.now()
  await transport.disconnect()
  const elapsed = Date.now() - t0

  assert.equal(endCalls, 1, '仍然要调 end() 放手')
  assert.ok(elapsed < 500, `死通道上 disconnect 应当立刻返回，实际花了 ${elapsed}ms`)
  // 负对照：不加这个分支 → 每次重连白等 2 秒（用户感觉「断线后卡一下」）
})

test('重连：活连接上 disconnect 仍然等 close（优雅关闭不能省）', async () => {
  const transport = new SshTransport({ host: 'example.invalid', username: 'x' })
  // ⚠️ 注意：`disconnect()` 会**先**把 `this.client` 置空，所以假 client 必须自己
  // 持有回调表，不能在 emit 时去读 `transport.client`（那时已经是 undefined 了）。
  const handlers = {}
  const client = {
    exec() {},
    end() {
      // 模拟「end() 之后 close 事件到达」
      setImmediate(() => handlers.close?.())
    },
    once(event, handler) {
      handlers[event] = handler
    },
  }
  transport.client = client
  transport.dead = false

  const t0 = Date.now()
  await transport.disconnect()
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 1000, `close 到达就该立刻返回，实际 ${elapsed}ms`)
  // 负对照：一律跳过等待 → 活连接上不等 close，可能丢未收完的数据
})

test('终端：死通道开终端要报错，**刻意不重连**', async () => {
  // 重连等于静默换一个新 shell —— 用户会以为自己还在原来那个会话里。
  // 那是谎报状态，比报错更坏。
  const { spawnSshTerminal } = await import('../src/terminal/backends.js')
  const dead = connectedTransport({ dead: true })
  let connectCalls = 0
  dead.connect = async () => {
    connectCalls += 1
  }

  await assert.rejects(
    () => spawnSshTerminal(dead, {}),
    (error) => {
      assert.equal(error.code, TRANSPORT_ERROR.NOT_CONNECTED)
      assert.match(error.message, /无法开终端/)
      return true
    },
  )
  assert.equal(connectCalls, 0, '终端不该触发重连')
  // 负对照：自动重连 → 用户以为在操作原会话，其实是一个全新的 shell
})
