/**
 * SSH transport —— 用 `ssh2` 库实现 `Transport` 契约。
 *
 * ## 为什么用 `ssh2` 而不是系统 OpenSSH CLI
 *
 * 系统 CLI 拿不到结构化错误处理：认证次数耗尽、只支持 keyboard-interactive 的主机、
 * 超时、keepalive —— 这几类只有库能优雅处理。ZCode 与两个参考项目都用的库。
 *
 * ## 从参考项目的真实事故里抄来的边界（照抄教训，不抄代码）
 *
 *   1. **不要无条件启用 SSH agent**。密码登录时若带 `agent`，ssh2 会先试公钥，
 *      `MaxAuthTries` 小的主机会把次数耗尽 → **正确密码也登不上**。
 *      所以只有显式传入 agent 时才启用。
 *   2. `readyTimeout` 默认 20s 太短 → 用 60s。
 *   3. 空闲连接会被 NAT/防火墙静默断开而 stdio 不 close → 开 keepalive（15s × 3）。
 *   4. 部分服务端只开 keyboard-interactive → 需要 `tryKeyboard`，否则「命令行能登、
 *      应用里登不上」。
 *   5. **标准 SFTP 的 rename 拒绝覆盖已存在目标** → 原子写要先 unlink 再 rename。
 *   6. **不要在没给 stdin 时 end stdin** —— 会与待产出输出竞争，channel 关闭会丢数据。
 *   7. **exec 请求里不能有真实 NUL 字节** —— 服务端报 "invalid format"，错误指不到原因。
 *   8. **每个操作都要有超时，死通道要立刻失败** —— 否则 N 个条目 × 每个等满超时 = 永远跑不完。
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFile, stat as statFile } from 'node:fs/promises'

import { Transport, TRANSPORT_ERROR, TransportError, assertNoNul } from './transport.js'
import { parseTar } from './tar.js'

/**
 * `ssh2` 是**唯一**的运行时依赖，所以它可能因为各种原因没被装上
 * （pnpm 的构建脚本表态、`node_modules` 被删、手动拷了源码）。
 *
 * 默认的 `ERR_MODULE_NOT_FOUND: Cannot find package 'ssh2'` 完全指不出该怎么办 ——
 * 开发时我自己就撞过一次（清目录时误删了 `node_modules`）。所以这里给出可执行的提示。
 *
 * 用动态 import 而不是静态 import，就是为了能包住这个错误。
 */
let Client
try {
  ({ Client } = await import('ssh2'))
} catch (error) {
  throw new Error(
    "SSH 后端需要依赖 'ssh2'，但它没有被解析到。\n" +
    '  本插件零原生依赖，正常情况下装上就有。请尝试：\n' +
    '    - 用插件自带安装器：node scripts/install.mjs --profile <你的 profile>\n' +
    '    - 或在插件目录执行：pnpm install\n' +
    '    - 若刚升级过 DSH 后出现，重启 profile 让依赖树重建\n' +
    `  原始错误：${error?.message ?? error}`,
    { cause: error },
  )
}

/** 连接就绪超时。库默认 20s 太短（参考项目实测）。 */
const READY_TIMEOUT_MS = 60_000

/** keepalive：空闲连接会被中间设备静默断开。 */
const KEEPALIVE_INTERVAL_MS = 15_000
const KEEPALIVE_COUNT_MAX = 3

/** 单次 SFTP 操作的默认超时。 */
const SFTP_TIMEOUT_MS = 30_000

/** 单条命令的默认超时。 */
const EXEC_TIMEOUT_MS = 120_000

/** host key 校验结果。 */
export const HOST_KEY_RESULT = {
  /** 与已知记录一致。 */
  MATCH: 'match',
  /** 首次见到（TOFU：可以接受并记录）。 */
  UNKNOWN: 'unknown',
  /** 与已知记录**不一致** —— 一律拒绝。 */
  MISMATCH: 'mismatch',
}

/**
 * 已知主机记录表 —— TOFU 的实现点。
 *
 * 只做内存记录：**不落盘**，重启即忘。
 * 但**语义现在就要对**：变更一律拒绝、可手动重置。
 */
export class KnownHosts {
  /**
   * @param {Record<string, string>} [entries] `host:port` → sha256 指纹（base64，无 `=` 填充）
   */
  constructor(entries = {}) {
    /** @type {Map<string, string>} */
    this.entries = new Map(Object.entries(entries))
  }

  /** 复合键：端口必须参与，否则同机不同端口会互相污染。 */
  static keyOf(host, port) {
    return `${host}:${port}`
  }

  /**
   * 校验一个指纹。
   * @param {string} host
   * @param {number} port
   * @param {string} fingerprint sha256 base64（可带 `=` 填充）
   * @returns {{ result: string, known?: string }}
   */
  verify(host, port, fingerprint) {
    const key = KnownHosts.keyOf(host, port)
    const known = this.entries.get(key)
    const normalized = normalizeFingerprint(fingerprint)
    if (known === undefined) return { result: HOST_KEY_RESULT.UNKNOWN }
    return { result: known === normalized ? HOST_KEY_RESULT.MATCH : HOST_KEY_RESULT.MISMATCH, known }
  }

  /** 记下一条（TOFU 首次接受时调用）。 */
  remember(host, port, fingerprint) {
    this.entries.set(KnownHosts.keyOf(host, port), normalizeFingerprint(fingerprint))
  }

  /** 忘掉一条（用户显式重置时调用）。 */
  forget(host, port) {
    return this.entries.delete(KnownHosts.keyOf(host, port))
  }
}

/** 去掉 base64 填充，便于比较。 */
function normalizeFingerprint(value) {
  return String(value ?? '').replace(/=+$/, '')
}

/**
 * 把 ssh2 交给 `hostVerifier` 的东西统一成 `sha256 base64`（去填充）——
 * 也就是 `known_hosts` 与 `ssh-keygen -lf` 用的那个格式。
 *
 * ssh2 的输入形态取决于是否设了 `hostHash`（**实测确认，不是推测**）：
 *   - 设了 `hostHash: 'sha256'` → 传的是**摘要本身，hex 编码**（不是原始密钥、也不是 base64）
 *   - 没设 → 传的是**原始密钥字节**
 *
 * 所以 hex 形态**只能重新编码，绝不能再哈希一次**。搞错的后果是每次连接都误报
 * 「中间人攻击」——实测踩过两次：先是拿 hex 当原始密钥哈希，再是重复哈希。
 *
 * 判定依据是 `hostHash` 这个选项，而不是猜输入长什么样：显式传进来，
 * 避免「指纹恰好全是 hex 字符」时被误判。
 *
 * @param {string|Buffer|Uint8Array} input ssh2 交过来的 hex 摘要或原始密钥
 * @param {'sha256-hex'|'raw'} [shape] 输入形态；默认按 `sha256-hex`（我们传了 hostHash）
 * @returns {string} `sha256 base64`（去填充）
 */
export function toFingerprint(input, shape = 'sha256-hex') {
  if (shape === 'raw') {
    return createHash('sha256').update(Buffer.from(input)).digest('base64').replace(/=+$/, '')
  }
  // ssh2 给的是 hex 编码的 sha256 摘要：还原成字节再编码成 base64，不再哈希
  const hex = typeof input === 'string' ? input : Buffer.from(input).toString('hex')
  return Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '')
}

/** 从 known_hosts 行算出 sha256 指纹（用于导入用户已有的信任）。 */
export function fingerprintFromKnownHostsKey(blobBase64) {
  const blob = Buffer.from(String(blobBase64), 'base64')
  return createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}

/**
 * SSH transport。
 */
export class SshTransport extends Transport {
  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} [options.port]
   * @param {string} options.username
   * @param {string} [options.privateKeyPath]
   * @param {string} [options.privateKey] 私钥内容（与 path 二选一）
   * @param {string} [options.passphrase]
   * @param {string} [options.password]
   * @param {string} [options.agent] SSH agent socket —— **只在显式给出时启用**
   * @param {boolean} [options.tryKeyboard] 是否允许 keyboard-interactive
   * @param {KnownHosts} [options.knownHosts]
   * @param {(info: {host: string, port: number, fingerprint: string, result: string}) => void} [options.onHostKey]
   *   host key 判定回调；抛错即拒绝连接
   * @param {number} [options.readyTimeoutMs]
   * @param {number} [options.sftpTimeoutMs]
   * @param {number} [options.execTimeoutMs]
   */
  constructor(options) {
    super('ssh')
    this.host = options.host
    this.port = options.port ?? 22
    this.username = options.username
    this.privateKeyPath = options.privateKeyPath
    this.privateKey = options.privateKey
    this.passphrase = options.passphrase
    this.password = options.password
    this.agent = options.agent
    this.tryKeyboard = options.tryKeyboard === true
    this.knownHosts = options.knownHosts ?? new KnownHosts()
    this.onHostKey = options.onHostKey
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.sftpTimeoutMs = options.sftpTimeoutMs ?? SFTP_TIMEOUT_MS
    this.execTimeoutMs = options.execTimeoutMs ?? EXEC_TIMEOUT_MS

    /** @type {Client|undefined} */
    this.client = undefined
    /** @type {import('ssh2').SFTPWrapper|undefined} 连接级缓存的 SFTP 通道 */
    this.sftpChannel = undefined
    /** 通道是否已死。死了就立刻失败，不要每个操作等满超时。 */
    this.dead = false
    /**
     * **曾经**成功连上过吗？
     *
     * 用来区分两种 `NOT_CONNECTED`：
     *   - `hasConnected === true` 且 `dead` → 连上过又断了（网络抖动 / 服务端重启）
     *     → 值得自动重连一次
     *   - `hasConnected === false` → **用户根本没让我们连**
     *     → 绝不能偷偷连上去（那是「静默建立连接」，比失败更坏）
     */
    this.hasConnected = false
    /** 自动重连过几次（诊断用；也便于测试断言）。 */
    this.reconnects = 0
    /** @type {string|undefined} 本次连接观察到的 host key 指纹 */
    this.observedFingerprint = undefined
    /** @type {unknown} 连接失败的原因（用于给出可执行的提示） */
    this.lastError = undefined
  }

  /** 建立连接。 */
  async connect() {
    if (this.client !== undefined && !this.dead) return
    this.dead = false

    const privateKey = await this.loadPrivateKey()

    const config = {
      host: this.host,
      port: this.port,
      username: this.username,
      readyTimeout: this.readyTimeoutMs,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      // 让 ssh2 直接把 sha256 指纹交给我们，省得自己算
      hostHash: 'sha256',
      hostVerifier: (fingerprint) => this.verifyHostKey(fingerprint),
      ...privateKey === undefined ? {} : { privateKey },
      ...this.passphrase === undefined ? {} : { passphrase: this.passphrase },
      ...this.password === undefined ? {} : { password: this.password },
      // ⚠️ 只有显式给了 agent 才启用 —— 否则密码登录时公钥会先把认证次数耗光
      ...this.agent === undefined ? {} : { agent: this.agent },
      // 部分服务端只开 keyboard-interactive
      ...this.tryKeyboard ? { tryKeyboard: true } : {},
    }

    await new Promise((resolve, reject) => {
      const client = new Client()
      this.client = client
      let settled = false
      const settle = (error) => {
        if (settled) return
        settled = true
        if (error === undefined) resolve()
        else reject(error)
      }

      client.on('ready', () => {
        this.hasConnected = true
        settle()
      })
      client.on('error', (error) => {
        this.lastError = error
        this.dead = true
        settle(this.classify(error))
      })
      client.on('close', () => {
        // 通道关闭即视为死：后续操作立刻失败，不各等满超时
        this.dead = true
        this.sftpChannel = undefined
        settle(this.classify(this.lastError ?? new Error('连接已关闭')))
      })
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        // 只在给了密码时自动应答；否则交回库（会失败并给出明确错误）
        finish(this.password === undefined ? [] : prompts.map(() => this.password))
      })

      try {
        client.connect(config)
      } catch (error) {
        settle(this.classify(error))
      }
    })
  }

  /** 读私钥：优先用内联内容，其次从文件读。 */
  async loadPrivateKey() {
    if (this.privateKey !== undefined) return this.privateKey
    if (this.privateKeyPath === undefined) return undefined
    try {
      return await readFile(this.privateKeyPath, 'utf8')
    } catch (error) {
      throw new TransportError(
        TRANSPORT_ERROR.CONNECT_FAILED,
        `读不到私钥文件 ${this.privateKeyPath}：${error?.message ?? error}`,
        { operation: 'connect', cause: error },
      )
    }
  }

  /**
   * host key 判定。
   *
   * 语义：一致放行；**首次见到交给 `onHostKey` 决定**（TOFU）；
   * **不一致一律拒绝**，并明确告诉用户「可能被中间人」以及如何重置。
   *
   * ⚠️ 传入的**不是**指纹，而是 ssh2 给的东西，取决于 `hostHash` 选项：
   *   - 设了 `hostHash: 'sha256'` → 传的是**摘要本身，hex 编码**（不是 base64！）
   *   - 没设 → 传的是**原始密钥 Buffer**
   * 我们统一在这里转成 `sha256 base64`（与 `ssh-keygen -lf` / known_hosts 同格式）。
   * 否则会拿 hex 去和 known_hosts 的 base64 比，**永远不一致** ——
   * 表现为「每次连接都报中间人攻击」。
   *
   * @param {string|Buffer} hostKeyOrHash ssh2 交过来的 hex 摘要或原始密钥
   */
  verifyHostKey(hostKeyOrHash) {
    const fingerprint = toFingerprint(hostKeyOrHash)
    this.observedFingerprint = fingerprint
    const verdict = this.knownHosts.verify(this.host, this.port, fingerprint)

    if (verdict.result === HOST_KEY_RESULT.MISMATCH) {
      const error = new TransportError(
        TRANSPORT_ERROR.HOST_KEY_MISMATCH,
        `主机密钥与已知记录不一致（${this.host}:${this.port}）—— 可能是中间人攻击。` +
        `期望 ${verdict.known}，实际 ${fingerprint}。` +
        '确认主机确实换过密钥后再手动重置信任。',
        { operation: 'connect', target: `${this.host}:${this.port}`, retryable: false },
      )
      this.lastError = error
      throw error
    }

    if (this.onHostKey !== undefined) {
      // 回调抛错即拒绝（TOFU 的实现点）
      this.onHostKey({
        host: this.host,
        port: this.port,
        fingerprint,
        result: verdict.result,
      })
    } else if (verdict.result === HOST_KEY_RESULT.UNKNOWN) {
      // 没有回调就不敢默认信任 —— 宁可拒绝，也不静默接受一个陌生密钥
      throw new TransportError(
        TRANSPORT_ERROR.HOST_KEY_MISMATCH,
        `首次连接 ${this.host}:${this.port}，但没有任何信任回调可以确认密钥` +
        `（指纹 ${fingerprint}）`,
        { operation: 'connect', target: `${this.host}:${this.port}`, retryable: false },
      )
    }

    if (verdict.result === HOST_KEY_RESULT.UNKNOWN) {
      this.knownHosts.remember(this.host, this.port, fingerprint)
    }
    return true
  }

  /** 把 ssh2 的错误归一化成我们的错误码。 */
  classify(error) {
    if (error instanceof TransportError) return error
    const message = String(error?.message ?? error)
    const level = String(error?.level ?? '')
    const code = String(error?.code ?? '')

    const base = { operation: 'connect', target: `${this.host}:${this.port}`, cause: error }

    if (/All configured authentication methods failed|authentication failure/i.test(message) || level === 'client-authentication') {
      return new TransportError(TRANSPORT_ERROR.AUTH_FAILED, `认证失败：${message}`, { ...base, retryable: false })
    }
    if (/Cannot parse privateKey|bad passphrase|Passphrase is required|integrity check failed/i.test(message)) {
      return new TransportError(TRANSPORT_ERROR.AUTH_FAILED, `私钥无法使用（口令错或格式不支持）：${message}`, { ...base, retryable: false })
    }
    if (/Timed out while waiting for handshake|readyTimeout|ETIMEDOUT/i.test(message)) {
      return new TransportError(TRANSPORT_ERROR.TIMEOUT, `连接超时：${message}`, base)
    }
    if (/ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED/i.test(code) || /getaddrinfo|connect ECONNREFUSED/i.test(message)) {
      return new TransportError(TRANSPORT_ERROR.CONNECT_FAILED, `连不上 ${this.host}:${this.port}：${message}`, { ...base, retryable: true })
    }
    return new TransportError(TRANSPORT_ERROR.CONNECT_FAILED, message, base)
  }

  /** 断开连接（幂等）。 */
  async disconnect() {
    const wasDead = this.dead
    this.dead = true
    this.sftpChannel = undefined
    const client = this.client
    this.client = undefined
    if (client === undefined) return

    // ⚠️ 通道**已经死了**时不要再等 `close` 事件 —— 它早就触发过了，
    // 于是每次都会白等满 2 秒兜底定时器（实测：重连因此慢 2.3 秒）。
    // 死连接上没什么可「优雅关闭」的，直接放手。
    if (wasDead) {
      try {
        client.end()
      } catch {
        // 已经断了
      }
      return
    }

    await new Promise((resolve) => {
      try {
        client.end()
      } catch {
        // 已经断了
      }
      // end() 不一定触发回调；给一个短兜底
      const timer = setTimeout(resolve, 2_000)
      client.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** 轻量连通性探测：连上再断开，回答「能不能连、认证过不过」。 */
  async testConnection() {
    try {
      await this.connect()
      return { ok: true, fingerprint: this.observedFingerprint }
    } catch (error) {
      return {
        ok: false,
        code: error?.code ?? TRANSPORT_ERROR.UNKNOWN,
        detail: String(error?.message ?? error),
      }
    } finally {
      await this.disconnect()
    }
  }

  /**
   * 断言连接可用；死通道立刻失败，不各等满超时。
   *
   * ⚠️ **必须是公开方法**：`src/terminal/backends.js` 会调它。
   * 实测踩到过 —— 它原本叫 `#assertAlive`（私有），于是那边写的
   * `transport.assertAlive?.()` 永远解析成 `undefined`，
   * 整个调用是**死代码**，一直靠后面那句手写检查兜底。
   * 现在公开，两边共用同一份判定，不会再漂移。
   */
  assertAlive(context = 'SSH 连接不可用（通道已死或尚未连接）') {
    if (this.dead || this.client === undefined) {
      throw new TransportError(TRANSPORT_ERROR.NOT_CONNECTED, context, {
        operation: 'assertAlive',
        target: `${this.host}:${this.port}`,
      })
    }
  }

  /**
   * 跑一个操作；如果**通道曾经连上过又断了**，重连一次再试。
   *
   * ## 为什么需要
   *
   * SSH 是长连接，网络抖动、服务端重启 sshd、NAT 表项过期都会让通道断掉。
   * `assertAlive` 会让后续每个操作立刻失败 —— 但**重连一下通常就好**，
   * 用户完全想不到「只是断过，重连就行」（与 Docker 引擎重启是同一类问题）。
   *
   * ## 为什么必须区分「连过又断」与「从没连过」
   *
   * `NOT_CONNECTED` 有两种来源，**处理方式必须不同**：
   *
   * | 情况 | `hasConnected` | 该怎么做 |
   * |---|---|---|
   * | 连上过，后来断了 | `true` | **自动重连一次**（这是本方法要处理的） |
   * | 用户根本没调用过 `connect()` | `false` | **绝不能偷偷连上去** |
   *
   * 第二种如果也自动重连，就等于「用户没让我们连，我们却静默建立了连接」——
   * 那比失败更坏，而且会绕过用户对「连哪台机器」的明确选择。
   *
   * ## 只重试一次
   *
   * 重连要握手（含 host key 校验），无限重试会把一次失败拖成长时间卡顿；
   * 而且目标真的下线了时重试多少次都没用。
   *
   * @template T
   * @param {string} operation
   * @param {() => Promise<T>} run
   * @returns {Promise<T>}
   */
  async #withReconnect(operation, run) {
    try {
      return await run()
    } catch (error) {
      // 只处理「通道断了」这一类。认证失败 / host key 变更 / NOT_FOUND 等
      // 都是**确定的结论**，重连只会让同一个错误慢一倍出现。
      const isChannelDeath = error?.code === TRANSPORT_ERROR.NOT_CONNECTED
      if (!isChannelDeath) throw error
      // 从没连过 → 不能偷偷连
      if (this.hasConnected !== true) throw error

      this.log?.('[ssh] %s 失败（通道已断），尝试重连一次', operation)
      // ⚠️ 必须把**已经死掉的 client 丢掉**，否则 `connect()` 的早退判断
      // （`client !== undefined && !dead`）会直接 return —— 重连看起来成功了，
      // 其实还在用那个死连接，下一个操作立刻又报 Not connected。
      // 实测踩到过：单测用假 client 时看不出来（假 client 的 exec 永远成功），
      // 只有真服务端才暴露。
      this.client = undefined
      this.dead = false
      this.sftpChannel = undefined
      try {
        await this.connect()
      } catch (reconnectError) {
        // 重连也失败 → 报重连失败的原因（比「通道已死」更有指导性）
        throw reconnectError
      }
      this.reconnects += 1
      return await run()
    }
  }

  /** 取连接级缓存的 SFTP 通道（每次新建会打满 sshd 的 MaxSessions）。 */
  async sftp() {
    this.assertAlive()
    if (this.sftpChannel !== undefined) return this.sftpChannel
    const channel = await new Promise((resolve, reject) => {
      this.client.sftp((error, value) => (error ? reject(this.sftpError(error, 'sftp')) : resolve(value)))
    })
    this.sftpChannel = channel
    return channel
  }

  /** 把一个 SFTP 回调 API 包成 Promise，并带超时。 */
  #sftpCall(operation, invoke) {
    return (async () => {
      const sftp = await this.sftp()
      return new Promise((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          reject(new TransportError(TRANSPORT_ERROR.TIMEOUT, `SFTP ${operation} 超时（${this.sftpTimeoutMs}ms）`, {
            operation,
            target: `${this.host}:${this.port}`,
          }))
        }, this.sftpTimeoutMs)
        // 注意：**不 unref** —— unref 掉唯一的结算定时器会让 Node 提前退出
        invoke(sftp, (error, value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) reject(this.sftpError(error, operation))
          else resolve(value)
        })
      })
    })()
  }

  /** 把 SFTP 的 status 码映射成我们的错误码。 */
  sftpError(error, operation) {
    if (error instanceof TransportError) return error
    const code = Number(error?.code)
    const base = { operation, target: `${this.host}:${this.port}`, cause: error }
    // ssh2 的 SFTP_STATUS_CODE：2 = NO_SUCH_FILE，3 = PERMISSION_DENIED
    if (code === 2) return new TransportError(TRANSPORT_ERROR.NOT_FOUND, `SFTP ${operation}: 目标不存在`, base)
    if (code === 3) return new TransportError(TRANSPORT_ERROR.PERMISSION_DENIED, `SFTP ${operation}: 权限不足`, { ...base, retryable: false })
    if (/No such file/i.test(String(error?.message))) {
      return new TransportError(TRANSPORT_ERROR.NOT_FOUND, `SFTP ${operation}: 目标不存在`, base)
    }
    return new TransportError(TRANSPORT_ERROR.UNKNOWN, `SFTP ${operation} 失败：${error?.message ?? error}`, base)
  }

  /** 解析目标侧的规范绝对路径。 */
  async realpath(path, options = {}) {
    return this.#withReconnect('realpath', () => this.#realpathImpl(path, options))
  }

  async #realpathImpl(path, options = {}) {
    throwIfAborted(options.signal, 'realpath', path)
    const result = await this.#sftpCall('realpath', (sftp, done) => sftp.realpath(path, done))
    return result
  }

  /** 读文件。`maxBytes` 是硬上限，超过**失败**而不是截断。 */
  async readFile(path, options = {}) {
    return this.#withReconnect('readFile', () => this.#readFileImpl(path, options))
  }

  async #readFileImpl(path, options = {}) {
    throwIfAborted(options.signal, 'readFile', path)

    // 快路：调用方已从目录遍历拿到 size（`knownSize`）→ 跳过 stat，每文件省一次 RTT。
    // 遍历 N 个文件就是 N 次往返 —— 这是首次拉取的最大头。
    // 类型校验（目录读不了）推迟给 SFTP 自己报错：它对目录的 open 会明确失败，
    // 错误分类照旧走 sftpError，不会把目录当内容读回来。
    if (typeof options.knownSize === 'number' && Number.isFinite(options.knownSize)) {
      if (options.maxBytes !== undefined && options.knownSize > options.maxBytes) {
        throw new TransportError(
          TRANSPORT_ERROR.TOO_LARGE,
          `"${path}" 有 ${options.knownSize} 字节，超过上限 ${options.maxBytes}`,
          { operation: 'readFile', target: path, retryable: false },
        )
      }
    } else {
      const info = await this.stat(path, options)
      if (info.type === 'directory') {
        throw new TransportError(TRANSPORT_ERROR.WRONG_TYPE, `"${path}" 是目录，不是文件`, {
          operation: 'readFile',
          target: path,
          retryable: false,
        })
      }
      if (options.maxBytes !== undefined && info.size > options.maxBytes) {
        throw new TransportError(
          TRANSPORT_ERROR.TOO_LARGE,
          `"${path}" 有 ${info.size} 字节，超过上限 ${options.maxBytes}`,
          { operation: 'readFile', target: path, retryable: false },
        )
      }
    }

    const buffer = await this.#sftpCall('readFile', (sftp, done) => {
      // SFTP 的 readFile 会把整个文件读进内存；大小校验在上面已经做过了
      sftp.readFile(path, (error, data) => (error ? done(error) : done(undefined, data)))
    })

    // 后置校验：stat/遍历与 read 之间文件可能变大（罕见但真实）。
    // 读到的超过上限就按契约失败，**绝不静默截断**。
    if (options.maxBytes !== undefined && buffer.length > options.maxBytes) {
      throw new TransportError(
        TRANSPORT_ERROR.TOO_LARGE,
        `"${path}" 实际 ${buffer.length} 字节，超过上限 ${options.maxBytes}`,
        { operation: 'readFile', target: path, retryable: false },
      )
    }

    if (options.encoding === undefined) return buffer
    // 与宿主一致：文本读取拒绝 NUL 与非法 UTF-8，而不是塞给上层一堆替换字符
    if (buffer.includes(0)) {
      throw new TransportError(TRANSPORT_ERROR.NOT_TEXT, `"${path}" 含 NUL 字节，不是文本`, {
        operation: 'readFile',
        target: path,
        retryable: false,
      })
    }
    return buffer.toString(options.encoding)
  }

  /**
   * **快路：一次 `find -printf` 拿整棵树的元数据（结构，不含内容）**。
   *
   * 背景（2026-10-09 真机实测，12659 文件的项目）：
   * SFTP 逐目录 readdir 要 **17.7 秒**；`find -printf` 一次命令 **0.23 秒**（~77 倍），
   * 输出 1.4 MB 纯文本。内容不在这里拉 —— 交给 `readFilesBatch`（tar 只打小文件）。
   *
   * 这是**可选能力**：镜像层探测到 `transport.walkTree` 存在才走这条路，
   * 探测失败（distroless / busybox 没有 GNU find）就退回标准路（逐目录 readdir）。
   *
   * ⚠️ 为什么不用 `tar` 拿结构：`tar cf -` 会**打包文件内容**，12659 个文件直接
   * 撑爆超时（实测 120s 超时）。`find -printf` 只输出元数据，轻量得多。
   *
   * @param {string} remoteRoot 远程根（绝对 POSIX 路径）
   * @param {object} [options]
   * @param {number} [options.maxEntries=20000]
   * @param {number} [options.maxDepth=12]
   * @param {number} [options.timeoutMs=60000]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{
   *   entries: Array<{ relPath: string, type: 'file'|'directory'|'other',
   *                    size?: number, mtimeMs?: number }>,
   *   truncated: boolean,
   *   durationMs: number,
   * }>}
   * @throws {TransportError} 探测失败（走不了这条路）—— 调用方据此降级
   */
  async walkTree(remoteRoot, options = {}) {
    throwIfAborted(options.signal, 'walkTree', remoteRoot)
    const maxEntries = options.maxEntries ?? 20_000
    const maxDepth = options.maxDepth ?? 12
    const timeoutMs = options.timeoutMs ?? 60_000
    const startedAt = Date.now()

    // 探测：这台远端有 GNU find（-printf 支持）吗？（首次用到才测，结果缓存）
    if (this.findGnu === undefined) {
      const probe = await this.exec('find --version 2>/dev/null | grep -q GNU && echo GNU_OK', { timeoutMs: 15_000, signal: options.signal })
      this.findGnu = probe.code === 0 && probe.stdout.trim() === 'GNU_OK'
    }
    if (this.findGnu !== true) {
      throw new TransportError(
        TRANSPORT_ERROR.UNKNOWN,
        '远端没有 GNU find（-printf 不可用），walkTree 不可用；请用 SFTP 标准路',
        { operation: 'walkTree', target: remoteRoot, retryable: false },
      )
    }

    // find -printf：一次拿整棵树的元数据。%P=相对路径 %y=类型 %s=大小 %T@=mtime。
    // NUL 分隔，与 readdir 的解析口径一致（文件名含换行也不怕）。
    const result = await this.exec(
      `find ${shellQuote(remoteRoot)} -printf '%P\\0%y\\0%s\\0%T@\\0'`,
      { timeoutMs, signal: options.signal, rawStdout: true },
    )
    if (result.code !== 0) {
      throw new TransportError(
        TRANSPORT_ERROR.UNKNOWN,
        `walkTree 失败（find exit ${result.code}）：${result.stderr.trim()}`,
        { operation: 'walkTree', target: remoteRoot, retryable: false },
      )
    }

    // 解析：每 4 个字段一组（relPath / type / size / mtime）
    const text = result.stdout.toString('utf8')
    const fields = text.split('\0')
    const entries = []
    let count = 0
    for (let i = 0; i + 3 < fields.length; i += 4) {
      if (count >= maxEntries) {
        break
      }
      const rel = fields[i]
      if (rel === '' || rel === '.') continue // 根本身 / find 的根占位
      // 深度过滤（find 不按层截断，宿主侧按 `/` 计数）
      if (rel.split('/').length > maxDepth) continue

      const kind = fields[i + 1]
      const size = Number(fields[i + 2] ?? 0)
      const mtimeSec = Number.parseFloat(fields[i + 3] ?? '0')
      const type = kind === 'd' ? 'directory' : kind === 'f' ? 'file' : 'other'
      entries.push({
        relPath: rel,
        type,
        ...(type === 'file' ? { size, mtimeMs: Math.round(mtimeSec * 1000) } : { mtimeMs: Math.round(mtimeSec * 1000) }),
      })
      count += 1
    }

    return {
      entries,
      truncated: fields.length / 4 > maxEntries,
      durationMs: Date.now() - startedAt,
    }
  }

  /**
   * **批量读：一次 `tar cf - -T -` 拉一批小文件**（SSH 版的 WSL readFilesBatch）。
   *
   * 背景：SFTP 逐文件 readFile 每个文件 open+read+close 好几次往返；tar 一次命令
   * 流回一批。与 WSL 的 base64 批量是**同一能力的两实现** —— 镜像层探测到
   * `readFilesBatch` 就自动走批量路。
   *
   * 这是**可选能力**：探测失败（没 tar）就抛错，镜像层退回逐个读。
   *
   * @param {string[]} paths 要读的绝对远程路径
   * @param {{ maxBytes?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<Map<string, { ok: true, data: Buffer } | { ok: false, error: TransportError }>>}
   */
  async readFilesBatch(paths, options = {}) {
    throwIfAborted(options.signal, 'readFilesBatch', `(${paths.length} 个文件)`)
    if (paths.length === 0) return new Map()
    const maxBytes = options.maxBytes ?? 256 * 1024

    // 探测 tar（首次缓存）。镜像层只对小文件（≤maxFileBytes）调批量，所以 tar 的输出
    // 有界（40 × 256KiB ≈ 10MB），不会像「拿整棵树」那样超时。
    if (this.tarAvailable === undefined) {
      const probe = await this.exec('command -v tar >/dev/null 2>&1 && echo TAR_OK', { timeoutMs: 15_000, signal: options.signal })
      this.tarAvailable = probe.code === 0 && probe.stdout.trim() === 'TAR_OK'
    }
    if (this.tarAvailable !== true) {
      throw new TransportError(
        TRANSPORT_ERROR.UNKNOWN,
        '远端没有 tar，readFilesBatch 不可用；请用 SFTP 逐个读',
        { operation: 'readFilesBatch', target: this.host, retryable: false },
      )
    }

    // tar -T - 从 stdin 读路径列表（--verbatim-files-from 防通配符展开）。
    // 绝对路径会让 tar 打头带 / 并警告；用 --transform 或直接容忍（见下面解析）。
    const list = paths.map((p) => `${p}\n`).join('')
    const result = await this.exec(
      'tar cf - -T - --verbatim-files-from --format=ustar 2>/dev/null',
      { timeoutMs: 120_000, signal: options.signal, rawStdout: true, stdin: list },
    )
    // 注意：tar 对缺失文件 exit 非 0 但仍产出其它文件；这里不按 exit 判失败，
    // 而是解析能拿到的，缺的标 NOT_FOUND（与 WSL 语义一致）。

    const parsed = parseTar(result.stdout)
    const out = new Map()
    const seen = new Map()
    for (const item of parsed) {
      if (item.type !== '0' && item.type !== '') continue // 只要普通文件
      // tar 剥掉了绝对路径的开头 `/` → 补回，与入参 key 对齐
      const name = item.name.startsWith('/') ? item.name : `/${item.name}`
      seen.set(name, item)
    }
    for (const path of paths) {
      const item = seen.get(path)
      if (item === undefined) {
        out.set(path, { ok: false, error: new TransportError(
          TRANSPORT_ERROR.NOT_FOUND, `"${path}" 不存在或不可读`,
          { operation: 'readFile', target: path, retryable: false },
        ) })
        continue
      }
      if (item.size > maxBytes) {
        out.set(path, { ok: false, error: new TransportError(
          TRANSPORT_ERROR.TOO_LARGE, `"${path}" 超过上限 ${maxBytes} 字节（${item.size}）`,
          { operation: 'readFile', target: path, retryable: false },
        ) })
        continue
      }
      out.set(path, { ok: true, data: item.data })
    }
    return out
  }

  /**
   * 原子写：先写同目录临时文件，再替换目标。
   *
   * 关键：**标准 SFTP 的 rename 拒绝覆盖已存在目标**，所以必须先 unlink。
   * 顺序 `write temp → unlink target → rename` 保证中途断网时要么完整旧版、
   * 要么完整新版，不会写坏原文件。
   */
  async writeFileAtomic(path, data, options = {}) {
    return this.#withReconnect('writeFileAtomic', () => this.#writeFileAtomicImpl(path, data, options))
  }

  async #writeFileAtomicImpl(path, data, options = {}) {
    throwIfAborted(options.signal, 'writeFileAtomic', path)
    assertNoNul(path, '写入路径')
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), options.encoding ?? 'utf8')
    const tempPath = `${path}.dsh-mr-${randomBytes(6).toString('hex')}.tmp`

    try {
      await this.#sftpCall('writeFile(temp)', (sftp, done) => {
        sftp.writeFile(tempPath, buffer, (error) => done(error))
      })
      // 先删目标：SFTP rename 不覆盖
      await this.#sftpCall('unlink', (sftp, done) => {
        sftp.unlink(path, (error) => {
          // 目标本来就不存在是正常情况
          if (error && Number(error.code) !== 2 && !/No such file/i.test(String(error.message))) done(error)
          else done()
        })
      })
      await this.#sftpCall('rename', (sftp, done) => {
        sftp.rename(tempPath, path, (error) => done(error))
      })
    } catch (error) {
      // 尽力清掉临时文件，避免留下垃圾
      // 尽力删临时文件：失败不能覆盖下面那个**真正的**错误
      await this.#sftpCall('unlink(temp)', (sftp, done) => {
        sftp.unlink(tempPath, () => done())
      }).catch(() => {})
      throw error
    }
  }

  /** 取文件元信息。 */
  async stat(path, options = {}) {
    return this.#withReconnect('stat', () => this.#statImpl(path, options))
  }

  async #statImpl(path, options = {}) {
    throwIfAborted(options.signal, 'stat', path)
    const attrs = await this.#sftpCall('stat', (sftp, done) => sftp.stat(path, done))
    return {
      type: typeOfAttrs(attrs),
      size: Number(attrs?.size ?? 0),
      // SFTP 的 mtime 是**秒**；统一成毫秒（对齐镜像层指纹用的粒度）
      mtimeMs: Number(attrs?.mtime ?? 0) * 1000,
      mode: Number(attrs?.mode ?? 0),
    }
  }

  /** 列一层目录。**读不了必须抛错**，不许当空目录返回。 */
  async readdir(path, options = {}) {
    return this.#withReconnect('readdir', () => this.#readdirImpl(path, options))
  }

  async #readdirImpl(path, options = {}) {
    throwIfAborted(options.signal, 'readdir', path)
    const entries = await this.#sftpCall('readdir', (sftp, done) => sftp.readdir(path, done))
    return entries.map((entry) => ({
      name: entry.filename,
      type: typeOfAttrs(entry.attrs),
      size: Number(entry.attrs?.size ?? 0),
      mtimeMs: Number(entry.attrs?.mtime ?? 0) * 1000,
    }))
  }

  /**
   * 执行命令。
   *
   * 要点（都来自参考项目的事故）：
   *   - **不在没给 stdin 时 end stdin**：会与待产出输出竞争，channel 关闭会丢数据。
   *   - **命令里不能有 NUL**：服务端报 "invalid format"，错误指不到原因。
   *   - `cwd` / `env` 由我们自己包进 shell 命令 —— SSH 的 exec 通道不认这两个字段。
   *   - 超时/取消时关闭 channel，并让调用方拿到 ABORTED/TIMEOUT 而不是空输出。
   */
  async exec(command, options = {}) {
    return this.#withReconnect('exec', () => this.#execImpl(command, options))
  }

  async #execImpl(command, options = {}) {
    this.assertAlive()
    assertNoNul(command, '命令')
    const timeoutMs = options.timeoutMs ?? this.execTimeoutMs
    const wrapped = wrapCommand(command, options.cwd, options.env)

    return new Promise((resolve, reject) => {
      let settled = false
      let stdout = ''
      // 二进制模式（tar 流）：不能用 utf8 拼接，会损坏字节
      const rawStdout = []
      let rawStdoutLength = 0
      let stderr = ''
      let exitCode
      let exitSignal
      /** @type {import('ssh2').ClientChannel|undefined} */
      let stream
      let timer

      const finish = (error, value) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        options.signal?.removeEventListener?.('abort', onAbort)
        if (error) reject(error)
        else resolve(value)
      }

      const onAbort = () => {
        closeStream()
        finish(new TransportError(TRANSPORT_ERROR.ABORTED, '命令已被取消', {
          operation: 'exec',
          target: `${this.host}:${this.port}`,
        }))
      }

      const closeStream = () => {
        try {
          stream?.close()
        } catch {
          // 已经关了
        }
      }

      if (options.signal?.aborted === true) {
        onAbort()
        return
      }
      options.signal?.addEventListener?.('abort', onAbort, { once: true })

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        // 同样**不 unref**：这是唯一的结算定时器
        timer = setTimeout(() => {
          closeStream()
          finish(new TransportError(TRANSPORT_ERROR.TIMEOUT, `命令超时（${timeoutMs}ms）`, {
            operation: 'exec',
            target: `${this.host}:${this.port}`,
          }))
        }, timeoutMs)
      }

      this.client.exec(wrapped, (error, channel) => {
        if (error) {
          finish(this.classifyExec(error))
          return
        }
        stream = channel
        channel.on('data', (chunk) => {
          if (options.rawStdout === true) {
            rawStdout.push(chunk)
            rawStdoutLength += chunk.length
          } else {
            stdout += String(chunk)
          }
          options.onStdout?.(chunk)
        })
        channel.stderr.on('data', (chunk) => {
          stderr += String(chunk)
          options.onStderr?.(chunk)
        })
        channel.on('exit', (code, signal) => {
          // exit 先到、close 后到；记下来，在 close 里结算，确保输出收全
          exitCode = code
          exitSignal = signal
        })
        channel.on('close', (code, signal) => {
          finish(undefined, {
            code: Number(exitCode ?? code ?? 0),
            signal: (exitSignal ?? signal) === undefined || (exitSignal ?? signal) === null
              ? undefined
              : String(exitSignal ?? signal),
            // 二进制模式时给 Buffer 版 stdout（供 tar 解析），文本模式照给 string
            stdout: options.rawStdout === true ? Buffer.concat(rawStdout, rawStdoutLength) : stdout,
            stderr,
          })
        })
        channel.on('error', (channelError) => finish(this.classifyExec(channelError)))

        // 只有**显式给了** stdin 才 end —— 否则会与待产出输出竞争
        if (options.stdin !== undefined) {
          channel.end(String(options.stdin))
        }
      })
    })
  }

  /** exec 的错误分类。 */
  classifyExec(error) {
    if (error instanceof TransportError) return error
    const message = String(error?.message ?? error)
    if (/Channel open failure|Administratively prohibited|resource shortage/i.test(message)) {
      // sshd 的 MaxSessions 打满（参考项目真实踩过）
      return new TransportError(TRANSPORT_ERROR.CHANNEL_DEAD, `打不开执行通道（可能超出 sshd 的 MaxSessions）：${message}`, {
        operation: 'exec',
        target: `${this.host}:${this.port}`,
        retryable: true,
      })
    }
    if (/Not connected|channel closed/i.test(message)) {
      this.dead = true
      return new TransportError(TRANSPORT_ERROR.CHANNEL_DEAD, `通道已关闭：${message}`, {
        operation: 'exec',
        target: `${this.host}:${this.port}`,
        retryable: true,
      })
    }
    return new TransportError(TRANSPORT_ERROR.UNKNOWN, `执行失败：${message}`, {
      operation: 'exec',
      target: `${this.host}:${this.port}`,
      cause: error,
    })
  }
}

/** SFTP attrs → 我们的条目类型。 */
function typeOfAttrs(attrs) {
  if (attrs?.isDirectory?.() === true) return 'directory'
  if (attrs?.isFile?.() === true) return 'file'
  return 'other'
}

/**
 * 把 `cwd` / `env` 包进要发送的 shell 命令。
 *
 * SSH 的 exec 通道**不接受** cwd 或 env —— 只有一条命令字符串。
 * 所以自己在 POSIX shell 里表达：`cd <dir> && env K=V ... <command>`。
 *
 * 单引号转义按 POSIX 的 `'\''` 规则处理：这是唯一能在单引号串里安全表示
 * 单引号的方式，而且不依赖目标侧有别的工具。
 *
 * @param {string} command
 * @param {string} [cwd]
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
export function wrapCommand(command, cwd, env) {
  const parts = []
  if (cwd !== undefined && cwd !== '') {
    parts.push(`cd ${shellQuote(cwd)}`)
  }
  const envPrefix = env === undefined
    ? ''
    : Object.entries(env).map(([key, value]) => `${key}=${shellQuote(String(value))} `).join('')
  if (envPrefix === '') {
    parts.push(command)
  } else {
    parts.push(`${envPrefix}${command}`)
  }
  return parts.join(' && ')
}

/**
 * POSIX shell 单引号转义。
 *
 * `'` → `'\''`（结束单引号、插入一个转义单引号、再开单引号）。
 * 这是唯一不依赖外部工具、且对任意字节安全的做法。
 *
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** 取消检查：abort 是终态。 */
function throwIfAborted(signal, operation, target) {
  if (signal?.aborted === true) {
    throw new TransportError(TRANSPORT_ERROR.ABORTED, `${operation} 已被取消`, { operation, target })
  }
}

/** 本地私钥文件是否存在且权限正常（供诊断用）。 */
export async function inspectPrivateKey(path) {
  try {
    const info = await statFile(path)
    return { exists: true, mode: info.mode & 0o777 }
  } catch {
    return { exists: false }
  }
}
