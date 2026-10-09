/**
 * 把「远程终端」接到宿主的 `ctx.terminals` 上。
 *
 * ## 为什么走 `registerBackend`
 *
 * 宿主把「终端」拆成了三层：`ctx.terminals` 管身份/授权/清理，
 * `TerminalBackend` 管「怎么开」，工具管「怎么呈现给模型」。
 * 我们只需要实现中间那层，**上层的授权、所有权、清理、以及界面的终端 UI 全部白拿** ——
 * 这是这个插件在终端这件事上最省力的接法。
 *
 * ## 一个必须注意的细节：后端名冲突
 *
 * `registerBackend` 把后端存进**服务级**的 Map（不是每个隔离域一份），
 * 同一个 `type` 重复注册会抛 `DUPLICATE_BACKEND`。
 * 官方那个本地 shell 后端占用了 `shell`，所以我们用 **`remote-shell`**。
 *
 * ## 隔离域
 *
 * 这个 backend 注册在**预设的隔离域内**，域里的 `ctx.terminals` 仍然是全局那个服务
 * （服务本身不隔离），但 backend 实例持有的是**域内的 transport** ——
 * 所以模型在远程会话里开终端，开出来的就是远程终端。
 */
import { TerminalSessionBase } from './session.js'

/** 我们注册的后端类型名。官方本地 shell 后端占用了 `shell`，所以这里必须不同。 */
export const REMOTE_TERMINAL_TYPE = 'remote-shell'

/**
 * 把一个 {@link TerminalSessionBase} 包成宿主契约要求的 `TerminalBackendSession`。
 *
 * 宿主契约（从 `dsh-terminal` 的类型声明确认）：
 *   `{ motd, pid?, startSend, read, signal, status, close }`
 *
 * 与我们的会话对象的差异只有三处，这里逐一对齐：
 *   1. `status()` 要带 `signal` 字段
 *   2. `signal()` 要返回 `{ delivered: true, targetPgid }`
 *   3. `startSend` 要抛 `SEND_ACTIVE`（我们的实现已经这么做了）
 */
class RemoteBackendSession {
  /**
   * @param {TerminalSessionBase} session
   * @param {string} motd
   */
  constructor(session, motd) {
    this.session = session
    /** 启动横幅（宿主会带给模型，说明这是什么终端）。 */
    this.motd = motd
    this.pid = session.pid
    this.closing = false
  }

  /**
   * 发一次文本并等待终端安静下来。
   * @param {{ text: string, submit: boolean, signal?: AbortSignal }} request
   */
  startSend(request) {
    if (this.closing) throw new Error('终端正在关闭')
    const operation = this.session.startSend({
      text: request.text,
      submit: request.submit,
      signal: request.signal,
    })

    // 宿主期望的 `TerminalSendOperation` 形状与我们的 SendOperation 基本一致，
    // 只把 done 的结果里的 sessionStatus 换成宿主口径（补 signal 字段）。
    return {
      done: operation.done.then((result) => ({
        viewport: result.viewport,
        waitReason: result.waitReason,
        sessionStatus: this.status(),
        truncated: result.truncated,
      })),
      readOutput: () => operation.readOutput(),
      cancel: () => operation.cancel(),
    }
  }

  /** 分页读滚动缓冲（口径与宿主一致）。 */
  read(request = {}) {
    return this.session.read(request)
  }

  /**
   * 改窗口大小。
   *
   * 宿主类型声明里没有这个方法，但**界面的终端面板需要它** ——
   * 面板尺寸变了要同步给远端，否则 `vim` / `top` 这类全屏程序会画错。
   * 后端不支持时（WSL 的 `script` 就没有这个能力）是**空操作**，
   * 由 `TerminalSessionBase.resize` 按 `pty` 能力自己判断。
   *
   * @param {number} cols
   * @param {number} rows
   */
  resize(cols, rows) {
    this.session.resize(cols, rows)
  }

  /**
   * 发信号。
   *
   * `targetPgid` 这个字段我们**拿不到真实值**（SSH 不报告 shell 的 pid；
   * Docker 的 exec 也没有 pgid 端点），所以如实返回 `0` 并在 `delivered` 里
   * 反映「信号是否真的发出去了」。**不编一个看起来像真的 pid。**
   */
  async signal(signal) {
    if (this.closing) throw new Error('终端正在关闭')
    await this.session.signal(signal)
    return { delivered: true, targetPgid: 0 }
  }

  /** 宿主口径的状态。 */
  status() {
    const status = this.session.status()
    if (status.kind === 'exited') {
      return { kind: 'exited', exitCode: status.exitCode ?? null, signal: status.signal ?? null }
    }
    return { kind: 'running' }
  }

  /** 幂等关闭。 */
  async close(reason) {
    this.closing = true
    await this.session.close(reason)
  }
}

/**
 * 宿主 `TerminalBackend` 实现：每个实例绑定一个**具体的远程连接**。
 *
 * 生命周期：连接建立时创建、断开时销毁。它不做连接管理 ——
 * 那是 `ConnectionManager` 的事。这里只回答「在这个连接上开一个终端」。
 */
export class RemoteTerminalBackend {
  /**
   * @param {object} options
   * @param {import('../transport/transport.js').Transport} options.transport
   * @param {string} options.label 给模型看的「这是哪台机器」
   * @param {string} [options.cwd] 终端初始目录（远程绝对路径）
   * @param {Partial<import('./session.js').TERMINAL_DEFAULTS>} [options.tuning]
   * @param {(message: string, ...rest: unknown[]) => void} [options.log]
   * @param {string} [options.type] 后端类型名（默认 {@link REMOTE_TERMINAL_TYPE}）
   */
  constructor(options) {
    if (options?.transport === undefined) throw new Error('RemoteTerminalBackend 需要 transport')
    this.transport = options.transport
    this.label = options.label ?? options.transport.kind
    this.cwd = options.cwd
    this.tuning = options.tuning
    this.log = options.log
    this.type = options.type ?? REMOTE_TERMINAL_TYPE
  }

  /**
   * 开一个远程终端。
   *
   * @param {object} spec 宿主的 `TerminalBackendSpawnSpec`
   * @returns {Promise<RemoteBackendSession>}
   */
  async spawn(spec) {
    const session = await this.transport.spawnTerminal({
      cwd: spec.cwd ?? this.cwd,
      cols: 80,
      rows: 24,
      signal: spec.signal,
    })

    if (session === undefined) {
      throw new Error(
        `后端 "${this.transport.kind}" 不支持交互式终端。` +
        '（不会退化成一个没有 PTY 的假终端 —— 那会在 sudo、密码输入、top 这类场景静默出错。）',
      )
    }
    if (this.tuning !== undefined) Object.assign(session.tuning, this.tuning)

    // 启动横幅：告诉模型/用户这是哪个后端的终端，以及 PTY 的真实能力。
    const ptyNote = session.pty
      ? 'PTY 已分配'
      : '⚠️ 没有 PTY（只是管道）—— 交互式程序、密码输入、全屏 TUI 可能不正常'
    const motd = `已连接到 ${this.label}（${this.transport.kind} 后端）\n${ptyNote}\n`

    this.log?.('[terminal] 已开远程终端：%s（pty=%s）', this.label, session.pty)
    return new RemoteBackendSession(session, motd)
  }
}

/**
 * 把一个 backend 注册到 `ctx.terminals`，返回「注册」与「注销」两个动作。
 *
 * 单独抽出来是因为注册时机很讲究：必须在**隔离域内**注册，
 * 这样域内的工具才能用 `remote-shell` 这个类型开到远程终端。
 *
 * @param {object} ctx 隔离域内的 ctx
 * @param {RemoteTerminalBackend} backend
 * @returns {() => void} 注销函数
 */
export function registerRemoteTerminalBackend(ctx, backend) {
  const terminals = ctx.get?.('terminals') ?? ctx.terminals
  if (terminals === undefined) {
    throw new Error('宿主没有 terminals 服务，无法注册远程终端后端')
  }
  return terminals.registerBackend(backend)
}
