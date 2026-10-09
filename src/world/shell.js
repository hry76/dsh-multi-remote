/**
 * 隔离域内的 `shell` provider —— 把命令执行转发到远程。
 *
 * 与 `world/fs.js` 一样，这个模块**只在预设的隔离域里挂载**；
 * 全局 `ctx.shell` 保持宿主实现，本地会话不受影响。
 *
 * ## 契约（来自宿主 `dsh-shell` 与消费方 `dsh-tool-bash`）
 *
 *   resolve(request) → 补全默认值的 spec（消费方在 execute 前调用）
 *   execute(spec)    → Promise<ShellProcess>
 *
 * `ShellProcess` 必须提供：
 *   - `result()`  → Promise<ShellResult>
 *   - `readOutput()` → 增量读取（连续两次读取不重复内容）
 *   - `done`      → 进程关闭时结算，**永不 reject**
 *   - `stop()`    → 终止
 *
 * `ShellResult` 的形状由 `canonicalBashResult()` 固定：
 *   `{ exitCode, signal, timedOut, aborted, timeoutMs, stdout: {text, truncated}, stderr: {...} }`
 *
 * ## 语义要点（宿主注释里写死的行为）
 *
 *   - `result()` **只在基础设施故障时 reject**。非零退出、超时杀、取消杀，
 *     都以「带描述的结果」resolve —— 并把第一因（`timedOut` / `aborted`）标出来。
 *   - `done` 结算于进程关闭，**永不 reject**。
 *   - `readOutput()` 是增量的：连续读取不重复输出。
 *   - `onExpiry: 'none'` 不设期限；`'kill'` 到点杀。
 *
 * ## 诚实说明（不谎报沙箱事实）
 *
 * 远程命令**不受本地 DSH 沙箱约束** —— 边界是目标账号自身的权限。
 * 所以这里 `sandboxMode` 恒为 `undefined`，绝不上报一个本地沙箱模式。
 */
import { routeByRemotePath, translateToRemote } from '../session/workspace-routes.js'
import { TRANSPORT_ERROR } from '../transport/transport.js'

/** 默认单次命令超时（毫秒），与宿主 bash-local 的默认一致。 */
const DEFAULT_TIMEOUT_MS = 120_000

/** 允许的最大超时，防止调用方传一个天文数字把会话挂死。 */
const MAX_TIMEOUT_MS = 600_000

/** `onExpiry: 'none'`（后台任务）时仍然保留的硬上限 —— 防止无限期占用通道。 */
const BACKGROUND_HARD_CAP_MS = 24 * 60 * 60 * 1000

/** 单流默认最大输出字节数。 */
const DEFAULT_MAX_OUTPUT_BYTES = 64_000

export const name = '@jk-uzi/dsh-multi-remote/world-shell'

/**
 * 把超时收敛到 [1, MAX_TIMEOUT_MS]。
 * @param {number|undefined} requested
 * @param {number} fallback
 */
function clampTimeout(requested, fallback) {
  if (requested === undefined) return fallback
  if (!Number.isFinite(requested) || requested <= 0) return fallback
  return Math.min(requested, MAX_TIMEOUT_MS)
}

/**
 * 一次远程执行。实现宿主 `ShellProcess` 的最小完整语义。
 *
 * **导出是为了测试**：`buildResult()` 的字段类型是硬契约 ——
 * 宿主 `tool-bash` 会把 `exitCode` / `signal` 直接放进工具输出，
 * 而输出要过 lossless-JSON 校验（`undefined` 会让整条结果被拒，
 * 表现为「远程会话里 bash 完全不能用」）。这条契约必须有测试钉住。
 */
export class RemoteShellProcess {
  /**
   * @param {object} options
   * @param {string} options.command
   * @param {string} options.workdir
   * @param {number} options.timeoutMs 实际生效的期限（后台任务用硬上限）
   * @param {boolean} options.armed 是否真的在到点时杀（`onExpiry: 'kill'`）
   * @param {number} options.stdoutMaxBytes
   * @param {import('../transport/transport.js').Transport} options.transport
   * @param {AbortSignal} [options.signal]
   */
  constructor(options) {
    this.command = options.command
    this.workdir = options.workdir
    this.timeoutMs = options.timeoutMs
    this.armed = options.armed
    this.stdoutMaxBytes = options.stdoutMaxBytes
    this.transport = options.transport
    this.signal = options.signal

    /** @type {string} */
    this.stdoutText = ''
    /** @type {string} */
    this.stderrText = ''
    /** 读取游标：保证连续读取不重复输出。 */
    this.stdoutCursor = 0
    this.stderrCursor = 0

    this.exitCode = undefined
    this.exitSignal = undefined
    this.timedOut = false
    this.aborted = false
    this.started = false
    /** 已杀掉（超时/取消/stop）时为 true。 */
    this.killed = false

    /** @type {Promise<void>} 进程关闭时结算，永不 reject。 */
    this.done = Promise.resolve()
    /** @type {Promise<object>|undefined} */
    this.resultPromise = undefined
  }

  /** 启动远程命令。返回自身，便于 `execute()` 直接 await。 */
  async start() {
    if (this.signal?.aborted === true) {
      this.aborted = true
      this.exitCode = undefined
      this.done = Promise.resolve()
      this.resultPromise = Promise.resolve(this.buildResult())
      return this
    }

    const controller = new AbortController()
    this.controller = controller
    const onAbort = () => {
      this.aborted = true
      controller.abort()
    }
    this.signal?.addEventListener?.('abort', onAbort, { once: true })

    // 期限计时器：**不能 unref**。unref 掉唯一的结算定时器会让 Node 提前退出，
    // 表现为「命令莫名其妙没跑完」（参考项目在 CI 上就撞过这个）。
    let timer
    if (this.armed) {
      timer = setTimeout(() => {
        this.timedOut = true
        controller.abort()
      }, this.timeoutMs)
    }

    this.started = true
    const exec = this.transport.exec(this.command, {
      cwd: this.workdir,
      signal: controller.signal,
      onStdout: (chunk) => {
        this.stdoutText += String(chunk)
      },
      onStderr: (chunk) => {
        this.stderrText += String(chunk)
      },
    })

    this.resultPromise = (async () => {
      try {
        const outcome = await exec
        this.exitCode = outcome?.code ?? 0
        this.stdoutText = typeof outcome?.stdout === 'string' ? outcome.stdout : this.stdoutText
        this.stderrText = typeof outcome?.stderr === 'string' ? outcome.stderr : this.stderrText
      } catch (error) {
        // 取消/超时是我们自己造成的：不当作基础设施故障，按第一因结算。
        if (this.aborted || this.timedOut || error?.code === TRANSPORT_ERROR.ABORTED) {
          this.exitCode = undefined
        } else {
          // 真正的执行故障：**这才允许 reject**。
          throw error
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        this.signal?.removeEventListener?.('abort', onAbort)
        this.closed = true
      }
      return this.buildResult()
    })()

    // `done` 永不 reject。
    this.done = this.resultPromise.then(() => undefined, () => undefined)
    return this
  }

  /** 组装宿主消费方要的结果形状。 */
  buildResult() {
    // ⚠️⚠️ **必须是 `null`，绝不能是 `undefined`** —— 这条踩过大坑（2026-10-07）：
    //
    // 宿主 `tool-bash` 组装输出时直接取这两个字段：
    //     exitCode: result.exitCode,
    //     signal:   result.signal,
    // 而宿主的 **lossless-JSON 校验遇到 `undefined` 会把整条结果判为非法**：
    //     Error: tool "bash" returned invalid output: value is not lossless JSON
    // 表现就是「远程会话里 bash 完全用不了，模型跑不了任何命令」。
    //
    // 而且 `signal` 之前**从来没被赋过值**（永远是 undefined）—— 所以每一次
    // bash 调用都必然失败。宿主的判据本身也是 `result.signal !== null`，
    // 说明契约就是 null。
    //
    // `exitSignal` 我们确实拿不到（传输层不报告杀死进程的信号），
    // 所以**如实给 null**，不编一个假信号名。
    return {
      exitCode: Number.isInteger(this.exitCode) ? this.exitCode : null,
      signal: typeof this.exitSignal === 'string' && this.exitSignal !== '' ? this.exitSignal : null,
      timedOut: this.timedOut === true,
      aborted: this.aborted === true,
      timeoutMs: this.timeoutMs,
      stdout: this.streamOf(this.stdoutText, this.stdoutMaxBytes),
      stderr: this.streamOf(this.stderrText, DEFAULT_MAX_OUTPUT_BYTES),
    }
  }

  /** 有界输出：超限就标记 truncated，并把完整内容落到 spill 之外（远程侧暂不落盘）。 */
  streamOf(text, maxBytes) {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes <= maxBytes) return { text, truncated: false }
    // 按字节截断会切断多字节字符，所以退到字符层面近似：保留头部。
    const ratio = maxBytes / bytes
    const head = text.slice(0, Math.max(0, Math.floor(text.length * ratio)))
    return { text: head, truncated: true }
  }

  /** 等待并返回结果。只有基础设施故障才 reject。 */
  result() {
    return this.resultPromise ?? Promise.reject(new Error('shell: 进程尚未启动'))
  }

  /**
   * 增量读取：连续两次读取返回的内容不重复。
   * @returns {{ stdout: {text, truncated}, stderr: {text, truncated}, running: boolean }}
   */
  readOutput() {
    const stdoutDelta = this.stdoutText.slice(this.stdoutCursor)
    const stderrDelta = this.stderrText.slice(this.stderrCursor)
    this.stdoutCursor = this.stdoutText.length
    this.stderrCursor = this.stderrText.length
    return {
      stdout: { text: stdoutDelta, truncated: false },
      stderr: { text: stderrDelta, truncated: false },
      running: this.closed !== true,
    }
  }

  /** 终止：优先温和，超时后由 transport 负责升级。 */
  async stop() {
    this.killed = true
    this.controller?.abort()
    await this.done
    return true
  }
}

export function apply(ctx, config = {}) {
  // 方案 A：shell 不再绑固定连接 —— 每次执行按 workdir 路由到对应工作区。
  const log = ctx.logger

  /**
   * 把 workdir 翻译成**远程绝对路径**并路由到所属工作区。
   *
   * 实测踩过的坑：`tool-bash` 会用**会话工作目录**作为默认 workdir，
   * 而会话 cwd 是本机锚点目录（`<盘符>:\...\anchors\mr-x`）—— 那个路径在远程不存在，
   * 报错就是远程 bash 的 `cd: <盘符>:\...\anchor: 没有那个文件或目录`。
   * 翻译 + 路由统一走 `translateToRemote`。
   *
   * @returns {{ remotePath: string, ctx: object }}
   */
  const toRemoteWorkdir = (workdir) => {
    const raw = String(workdir ?? '').trim()
    if (raw === '') {
      throw new Error('shell: 无法确定命令在哪个远程项目执行（workdir 为空且没有可路由的上下文）')
    }
    try {
      return translateToRemote(raw)
    } catch (error) {
      if (error?.code === TRANSPORT_ERROR.NOT_CONNECTED || error?.code === TRANSPORT_ERROR.NOT_FOUND) {
        throw error
      }
      throw new Error(`shell: ${error?.message ?? '无法确定远程工作目录'}`)
    }
  }

  /** 活跃进程集合：组合拆除时全部终止，不留孤儿。 */
  const live = new Set()

  const executor = {
    /**
     * 远程命令不受本地 DSH 沙箱约束 —— 边界是目标账号自身的权限。
     * 这里恒为 `undefined`，**绝不谎报**一个本地沙箱模式。
     */
    get sandboxMode() {
      return undefined
    },

    /** 补全默认值。消费方在 `execute()` 之前调用。 */
    resolve(request = {}) {
      const onExpiry = request.onExpiry ?? 'kill'
      const timeoutMs = onExpiry === 'none'
        ? clampTimeout(request.timeoutMs, BACKGROUND_HARD_CAP_MS)
        : clampTimeout(request.timeoutMs, DEFAULT_TIMEOUT_MS)
      return {
        command: String(request.command ?? ''),
        // 关键：把本机锚点路径翻译成远程路径（工具默认传的是会话 cwd = 锚点）
        workdir: request.workdir === undefined || String(request.workdir).trim() === '' ? undefined : toRemoteWorkdir(request.workdir).remotePath,
        timeoutMs,
        onExpiry,
        stdoutMaxBytes: request.stdoutMaxBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        ...request.signal === undefined ? {} : { signal: request.signal },
        ...request.env === undefined ? {} : { env: request.env },
      }
    },

    /** 执行命令，返回进程句柄。 */
    async execute(spec = {}) {
      const command = String(spec.command ?? '')
      if (command.trim() === '') {
        throw new Error('shell: command 不能为空')
      }
      const routed = toRemoteWorkdir(spec.workdir)
      const process = new RemoteShellProcess({
        command,
        workdir: routed.remotePath,
        timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        armed: (spec.onExpiry ?? 'kill') === 'kill',
        stdoutMaxBytes: spec.stdoutMaxBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        transport: routed.ctx.transport,
        signal: spec.signal,
      })
      live.add(process)
      process.done.finally(() => live.delete(process))
      await process.start()
      return process
    },
  }

  ctx.provide('shell', executor)

  // 组合拆除时终止所有仍在跑的远程命令，不留孤儿进程。
  ctx.effect(() => () => {
    const running = [...live]
    live.clear()
    return Promise.allSettled(running.map((process) => process.stop()))
  }, 'world-shell: 终止活跃远程命令')

  log?.info?.('[world-shell] 隔离域 shell 已挂载（按 workdir 路由，不绑固定连接）')
}
