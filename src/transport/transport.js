/**
 * Transport —— 三个后端（SSH / WSL / Docker）的唯一接口。
 *
 * 上层（镜像层、隔离域内的 fs/shell provider、工具、UI）**只认这个接口**，
 * 不认具体后端。这是「一个插件三个功能」的成本关键：SSH 打磨对了，
 * WSL / Docker 基本只是填 Transport。
 *
 * 本文件**只有契约与错误分类**，没有实现 —— 也刻意不引入任何 npm 依赖。
 *
 * 设计约束（都是踩出来的，不是猜的）：
 *   - **每个操作都必须能取消**：弱网下一次 `readFile` 可能挂很久，
 *     没有取消就会让会话永久卡在 running。
 *   - **每个操作都必须有超时**：且超时定时器**不能 unref** ——
 *     unref 掉唯一的结算定时器会让 Node 提前退出，表现为「测试莫名 cancelled」。
 *   - **连接要缓存通道**：每次操作新建 SFTP 通道会打满 sshd 的 MaxSessions。
 *   - **死通道要立刻失败**：否则 N 个条目 × 每个等满超时 = 永远跑不完。
 */

/** Transport 层错误码。调用方按 `code` 分支，**绝不解析 message 文案**。 */
export const TRANSPORT_ERROR = {
  /** 尚未连接，或连接已断开。 */
  NOT_CONNECTED: 'TRANSPORT_NOT_CONNECTED',
  /** 连接建立失败（网络不可达、认证失败、host key 不匹配等）。 */
  CONNECT_FAILED: 'TRANSPORT_CONNECT_FAILED',
  /** 认证失败。单独分类，便于给出可执行提示（密码错 / 密钥被拒 / 认证次数耗尽）。 */
  AUTH_FAILED: 'TRANSPORT_AUTH_FAILED',
  /** host key 校验失败（TOFU 变更或首次不信任）。 */
  HOST_KEY_MISMATCH: 'TRANSPORT_HOST_KEY_MISMATCH',
  /** 通道已死（对端断开、keepalive 失败）。收到后应立即失败，不要重试等待。 */
  CHANNEL_DEAD: 'TRANSPORT_CHANNEL_DEAD',
  /** 操作超时。 */
  TIMEOUT: 'TRANSPORT_TIMEOUT',
  /** 调用方取消。**这是终态**，不允许转而去走更慢的回退路径。 */
  ABORTED: 'TRANSPORT_ABORTED',
  /** 目标不存在。 */
  NOT_FOUND: 'TRANSPORT_NOT_FOUND',
  /** 目标存在但不是期望的类型（例如把目录当文件读）。 */
  WRONG_TYPE: 'TRANSPORT_WRONG_TYPE',
  /** 内容不是文本（含 NUL 或无法按声明编码解码）。 */
  NOT_TEXT: 'TRANSPORT_NOT_TEXT',
  /** 超过大小上限。**必须失败，不许截断**。 */
  TOO_LARGE: 'TRANSPORT_TOO_LARGE',
  /** 权限不足（目标账号自身权限，与本地沙箱无关）。 */
  PERMISSION_DENIED: 'TRANSPORT_PERMISSION_DENIED',
  /** 其余未分类失败。 */
  UNKNOWN: 'TRANSPORT_UNKNOWN',
}

/** Transport 层错误。带 `code`、`operation` 与可选 `cause`。 */
export class TransportError extends Error {
  /**
   * @param {string} code 见 {@link TRANSPORT_ERROR}
   * @param {string} message 面向开发者的描述（面向用户的文案由上层分类后生成）
   * @param {{ operation?: string, target?: string, cause?: unknown, retryable?: boolean }} [details]
   */
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'TransportError'
    this.code = code
    this.operation = details.operation ?? ''
    this.target = details.target ?? ''
    /** 是否值得重试。默认：只有超时与死通道可重试，取消与权限不可重试。 */
    this.retryable = details.retryable ?? (code === TRANSPORT_ERROR.TIMEOUT || code === TRANSPORT_ERROR.CHANNEL_DEAD)
  }
}

/**
 * 目录项类型。刻意只保留三类：上层不需要区分 FIFO / socket / 设备文件，
 * 但必须知道「这是目录、是普通文件、还是打不开的别的东西」。
 * @typedef {'file'|'directory'|'other'} EntryType
 */

/**
 * 一条目录项。
 * @typedef {object} DirEntry
 * @property {string} name 条目名（不含路径分隔符）
 * @property {EntryType} type
 * @property {number} [size] 字节数；后端能给出时才有
 * @property {number} [mtimeMs] 修改时间（毫秒）。用于「跳过未变化」的判断
 */

/**
 * 文件元信息。
 * @typedef {object} FileStat
 * @property {EntryType} type
 * @property {number} size 字节数
 * @property {number} mtimeMs 修改时间（毫秒）
 */

/**
 * Transport 契约。三个后端各实现一份。
 *
 * 所有异步方法都接受一个可选的 `AbortSignal`，并且**必须**在收到 abort 时
 * 尽快以 `TRANSPORT_ABORTED` 失败 —— 不允许「先试慢路径再说」。
 *
 * @interface Transport
 */
export class Transport {
  /** @param {'ssh'|'wsl'|'docker'} kind */
  constructor(kind) {
    if (this.constructor === Transport) {
      throw new Error('Transport 是抽象契约，请实现具体后端')
    }
    /** @type {'ssh'|'wsl'|'docker'} */
    this.kind = kind
    /**
     * 「拉一批文件」时建议的并发路数。上层（镜像层）按它分批，
     * **后端自己仍须硬限流**（见 WSL 的 `#acquire`：8 路以上会打死 relay）——
     * 这个值只是「别一次发出比这更多的请求」的礼貌约定。
     * - SSH：长连接 + SFTP 天然支持流水线，8 路是 sshd 默认 MaxSessions 的一半（留余量）
     * - WSL：4（`MAX_CONCURRENT`，实测硬上限）
     * - Docker：HTTP 命名管道，无所谓，给个温和值
     * @type {number}
     */
    this.readConcurrency = 8
  }

  /** @returns {Promise<void>} 建立连接。失败抛 {@link TransportError}。 */
  async connect() {
    throw notImplemented('connect')
  }

  /** @returns {Promise<void>} 断开并释放所有通道。必须幂等。 */
  async disconnect() {
    throw notImplemented('disconnect')
  }

  /**
   * 轻量连通性探测：不建立完整会话，只回答「能不能连上、认证过不过」。
   * @returns {Promise<{ ok: boolean, detail?: string }>}
   */
  async testConnection() {
    throw notImplemented('testConnection')
  }

  /**
   * 解析目标侧的规范绝对路径。
   * 用途：把 `~`、相对路径、符号链接统一成真实路径 —— 也是路径围栏的前提。
   * @param {string} path
   * @param {{ cwd?: string, signal?: AbortSignal }} [options]
   * @returns {Promise<string>}
   */
  async realpath(path, options) {
    throw notImplemented('realpath')
  }

  /**
   * 读文件。
   * @param {string} path
   * @param {{ encoding?: BufferEncoding, maxBytes?: number, signal?: AbortSignal,
   *           knownSize?: number }} [options]
   *   `maxBytes` 是**硬上限**：超过必须以 `TRANSPORT_TOO_LARGE` 失败，绝不截断。
   *   `knownSize`：调用方**已经知道**的文件大小（比如目录遍历时拿到的）。
   *   给了它，实现可以跳过「先 stat 查大小」那次往返 —— SSH 上每个文件省一次 RTT。
   *   实现仍须校验实际读到的长度（远端可能刚好在这之间变了，见各实现的说明）。
   * @returns {Promise<string|Buffer>}
   */
  async readFile(path, options) {
    throw notImplemented('readFile')
  }

  /**
   * 原子写文件：先写同目录临时文件，再 rename 覆盖。
   *
   * 为什么必须原子：中途断网不能把原文件写坏 —— 要么完整旧版，要么完整新版。
   * 注意标准 SFTP 的 rename **拒绝覆盖已存在目标**，所以实现要先 unlink 再 rename，
   * 或者使用后端提供的原子替换原语。
   *
   * @param {string} path
   * @param {string|Buffer} data
   * @param {{ encoding?: BufferEncoding, mode?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<void>}
   */
  async writeFileAtomic(path, data, options) {
    throw notImplemented('writeFileAtomic')
  }

  /**
   * 取文件元信息。
   * @param {string} path
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<FileStat>}
   */
  async stat(path, options) {
    throw notImplemented('stat')
  }

  /**
   * 列一层目录。
   *
   * 实现约定：**读不了必须抛错**，不许把失败当成空目录返回 ——
   * 参考项目就栽在这里（`readdir` 失败被吞掉，表现为静默丢整棵子树）。
   *
   * @param {string} path
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<DirEntry[]>}
   */
  async readdir(path, options) {
    throw notImplemented('readdir')
  }

  /**
   * 执行命令。
   * @param {string} command 交给目标侧 POSIX shell 执行的命令
   * @param {{ cwd?: string, env?: Record<string,string>, timeoutMs?: number, signal?: AbortSignal,
   *           onStdout?: (chunk: Buffer) => void, onStderr?: (chunk: Buffer) => void }} [options]
   * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
   */
  async exec(command, options) {
    throw notImplemented('exec')
  }

  /**
   * 开一个**交互式终端**（PTY）。
   *
   * 与 `exec` 的区别是本质性的：`exec` 是「跑完拿结果」，终端是
   * 「持续双向：写进去、读出来、还能发信号」。所以这里返回的是一个**活的会话对象**，
   * 而不是一次性的结果。
   *
   * ## 后端能力差异（实测）
   *
   * | 后端 | 怎么拿 PTY | 备注 |
   * |---|---|---|
   * | SSH | ssh2 的 `shell()` 通道 | 原生 PTY，`setWindow` 可用 |
   * | Docker | `exec` + `Tty: true`（raw stream） | 原生 PTY，`resize` 有对应端点 |
   * | WSL | `wsl.exe -e script -qec <cmd> /dev/null` | util-linux 的 `script` 分配 PTY；`script` 缺失时**明确失败**，不假装有 PTY |
   *
   * **不支持时返回 `undefined`**，而不是抛错 —— 调用方据此明确告诉用户
   * 「这个后端没有交互式终端」，而不是给一个坏掉的终端。
   *
   * @param {TerminalSpawnSpec} spec
   * @returns {Promise<TerminalSession|undefined>} `undefined` = 该后端不支持交互式终端
   */
  async spawnTerminal(spec) {
    // 动态 import：`terminal/backends.js` 要引用本文件的 TransportError，
    // 顶层互相 import 会形成模块环。放到调用时解析，环就不存在了。
    const { spawnTerminal } = await import('../terminal/backends.js')
    return spawnTerminal(this, spec ?? {})
  }
}

/**
 * 开终端时的参数。
 * @typedef {object} TerminalSpawnSpec
 * @property {string} [command] 要跑的命令（默认目标侧登录 shell）
 * @property {string} [cwd] 初始工作目录（绝对路径）
 * @property {Record<string,string>} [env]
 * @property {number} [cols] 终端列数（默认 80）
 * @property {number} [rows] 终端行数（默认 24）
 * @property {string} [term] `TERM` 值（默认 `xterm-256color`）
 * @property {AbortSignal} [signal]
 */

/**
 * 一个活的交互式终端会话。
 *
 * 约定：
 *   - `write` 是**幂等追加**的：调用方负责把用户输入原样送来（含 `\r`）。
 *   - `onData` 可能被调用多次；数据是**原始字节**（含 ANSI 转义），由上层决定怎么呈现。
 *   - `close()` 必须幂等，且**必须真的结束远端进程**（不是只关本地流）。
 *   - `exitCode` 在进程结束前是 `null`。
 *
 * @typedef {object} TerminalSession
 * @property {number} [pid] 目标侧进程号（拿不到时为 undefined）
 * @property {(data: string|Buffer) => void} write 往终端里写
 * @property {(cols: number, rows: number) => void} resize 改窗口大小（不支持时是空操作）
 * @property {(signal: string) => Promise<void>} signal 给前台进程组发信号
 * @property {() => { kind: 'running' } | { kind: 'exited', exitCode: number|null }} status
 * @property {() => Promise<void>} close
 * @property {(listener: (chunk: Buffer) => void) => () => void} onData 订阅输出，返回退订函数
 * @property {(listener: (info: { exitCode: number|null }) => void) => () => void} onExit 订阅退出，返回退订函数
 * @property {boolean} pty 是否**真的**有 PTY（false = 只是管道，能力有限）
 */

/** 未实现的占位错误，避免子类漏实现时静默变成 `undefined`。 */
function notImplemented(method) {
  return new TransportError(TRANSPORT_ERROR.UNKNOWN, `Transport.${method} 未实现`, { operation: method })
}

/**
 * 参数守卫：任何要送进目标侧 shell 的字符串都不许含 NUL。
 *
 * 参考项目实测：exec 请求里带真实 NUL 字节会被服务端以 "invalid format" 拒绝，
 * 而错误信息完全指不到原因。
 *
 * @param {string} value
 * @param {string} what
 */
export function assertNoNul(value, what) {
  if (String(value).includes('\0')) {
    throw new TransportError(TRANSPORT_ERROR.UNKNOWN, `${what} 含 NUL 字节，不能发送`, { operation: 'assertNoNul' })
  }
}
