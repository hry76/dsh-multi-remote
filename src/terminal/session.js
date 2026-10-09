/**
 * 终端会话的**共用机械**：有界滚动缓冲 + 就绪判定 + 发送操作。
 *
 * ## 为什么要共用
 *
 * 三个后端拿 PTY 的方式完全不同（ssh2 的 `shell()` 通道 / Docker 的 `Tty: true` exec /
 * WSL 的 `script`），但拿到之后的**行为契约是同一个**：
 * 保留有界输出、判断「命令跑完了」、把一次「发文本 + 等结果」做成一个可取消的操作。
 *
 * 这三件事跟「怎么连上」无关，所以放这里，让三个后端各自只关心自己的传输细节。
 * 这与 `Transport` 抽象本身是同一个思路 —— 把与后端无关的部分只写一遍。
 *
 * ## 就绪判定（`waitReason`）怎么来
 *
 * 终端里没有「命令结束」的信号，只能靠推断。四种结局（与宿主契约一致）：
 *
 * | waitReason | 什么时候 | 靠不靠谱 |
 * |---|---|---|
 * | `session_exit` | 顶层 shell 退了 | 确定 |
 * | `stdin_read` | 前台进程在等输入（读了 stdin） | 确定（有 PTY 时靠 tty 状态） |
 * | `inferred_idle` | 一段时间没有新输出 | **推断**，慢命令可能误判 |
 * | `timeout` | 到点还没安静 | 明确告知，不假装成功 |
 *
 * 这里刻意**把不确定性暴露出来**（返回 `waitReason` 而不是布尔），
 * 因为「命令跑完了」和「命令还在跑只是没输出」在上层看来必须能区分。
 */

/** 默认参数。 */
export const TERMINAL_DEFAULTS = {
  /** 滚动缓冲保留多少行。 */
  scrollbackLines: 2000,
  /** 单次发送最多等多久（毫秒）。 */
  sendTimeoutMs: 30_000,
  /** 输出安静多久算「跑完了」（毫秒）。 */
  idleSilenceMs: 600,
  /**
   * **首次**发送前，最多花多久等终端安静下来（毫秒）。
   *
   * 为什么需要：登录 banner（motd / 未读邮件 / 「需要重启系统」这类提示）在
   * shell 到提示符之前会持续输出。而 PTY 的**行规程会立刻回显**我们写进去的字节
   * —— 于是「已回显 + 一个 >600ms 的间隙」会被误判成「跑完了」，
   * 结果拿到的输出里只有 banner 和命令回显，**没有命令真正的输出**。
   * （实测：真靶机有中文 motd，`send` 立刻返回、`TTY=...` 根本没出现。）
   *
   * 所以首次发送前先等「安静」—— 安静意味着 banner 打完、shell 到了提示符。
   * 若一直不安静（例如对面根本不打任何东西），到这个上限就照常发送，
   * 并在结果里如实标 `readyReason: 'not-quiet-yet'`。
   */
  awaitReadyTimeoutMs: 3_000,
  /** 轮询间隔（毫秒）。 */
  pollIntervalMs: 100,
  /** 一次 `read` 最多返回多少行。 */
  maxReadLines: 500,
}

/**
 * 有界滚动缓冲：只保留最近 N 行。
 *
 * 为什么按行而不是按字节：宿主契约（`TerminalReadResult`）是按行分页的
 * （`totalLines` / `lineBegin` / `lineEnd`），按字节存还得再切一次。
 *
 * 为什么要截断：终端可以无限吐输出（`yes`、`cat` 大文件），
 * 不设界就是内存泄漏。**截断要如实标记**，不能假装拿到了全部。
 */
export class BoundedScrollback {
  /**
   * @param {{ maxLines?: number }} [options]
   */
  constructor(options = {}) {
    this.maxLines = options.maxLines ?? TERMINAL_DEFAULTS.scrollbackLines
    /** @type {string[]} 已完成的整行。 */
    this.lines = []
    /** 最后一行还没收到换行的部分。 */
    this.partial = ''
    /** 因为超界被丢掉了多少行（如实记账，用于 `truncated`）。 */
    this.droppedLines = 0
  }

  /**
   * 追加一段输出。
   *
   * 注意输出是**流式**的：一次 chunk 可能含多行，也可能半行。
   * 所以要按 `\n` 切开，最后一段留在 `partial` 里等下一次。
   *
   * @param {string} text
   */
  append(text) {
    if (text === '') return
    const combined = this.partial + text
    const parts = combined.split('\n')
    // 最后一段没有换行 → 还是「进行中的那一行」
    this.partial = parts.pop() ?? ''
    for (const line of parts) this.lines.push(line)

    if (this.lines.length > this.maxLines) {
      const excess = this.lines.length - this.maxLines
      this.lines.splice(0, excess)
      this.droppedLines += excess
    }
  }

  /** 当前总行数（含未完成的那一行）。 */
  get totalLines() {
    return this.lines.length + (this.partial === '' ? 0 : 1)
  }

  /** 取全部文本（已完成的行 + 未完成的尾巴）。 */
  text() {
    return this.partial === '' ? this.lines.join('\n') : [...this.lines, this.partial].join('\n')
  }

  /**
   * 分页读。
   *
   * `offset` 是**相对最新一行**的偏移（0 = 最新那一段），与宿主契约一致：
   * 终端最有用的永远是最新的输出。
   *
   * 返回的 `lineBegin` / `lineEnd` 也按**宿主的口径**给：它们是「相对最新的偏移」，
   * 不是绝对行号（宿主实现如此，照抄口径才不会让分页错位）。
   *
   * @param {{ offset?: number, count?: number }} [request]
   * @returns {{ text: string, totalLines: number, lineBegin: number, lineEnd: number, truncated: boolean }}
   */
  read(request = {}) {
    const all = this.partial === '' ? this.lines : [...this.lines, this.partial]
    const total = all.length
    const offset = request.offset ?? 0
    const count = request.count ?? TERMINAL_DEFAULTS.maxReadLines

    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('终端 read 的 offset 必须是非负整数')
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('终端 read 的 count 必须是正整数')

    if (offset >= total) {
      return { text: '', totalLines: total, lineBegin: offset, lineEnd: offset, truncated: this.droppedLines > 0 }
    }

    const end = total - offset
    const start = Math.max(0, end - count)
    const text = all.slice(start, end).join('\n')
    const returnedLines = text === '' ? 0 : text.split('\n').length

    return {
      text,
      totalLines: total,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      // ⚠️ `truncated` **只**表示「滚动缓冲丢过行」——也就是「这段历史已经不存在了」。
      // 不能把「这次分页没覆盖到开头」也算进来：那是正常分页，
      // 调用方靠 `lineBegin`/`lineEnd`/`totalLines` 自己判断还有没有更早的内容。
      // （宿主自带后端也是这个口径。）
      truncated: this.droppedLines > 0,
    }
  }

  /** 从某个位置之后取增量（发送操作用）。 */
  sliceFrom(index) {
    const all = this.partial === '' ? this.lines : [...this.lines, this.partial]
    return all.slice(index).join('\n')
  }

  /** 当前行数（用于记录「这次发送从哪开始」）。 */
  mark() {
    return this.totalLines
  }
}

/**
 * 一个可取消的「发送 + 等待」操作。
 *
 * 生命周期：`startSend()` 立刻返回本对象，调用方可以：
 *   - `await operation.done` —— 前台等它安静下来
 *   - `operation.readOutput()` —— 随时看已经攒了多少输出
 *   - `operation.cancel()` —— 放弃等待（**不杀进程**，只是不再等）
 *
 * 「放弃等待」与「杀掉进程」是两件事，刻意分开：用户可能只是想先看看输出。
 */
export class SendOperation {
  /**
   * @param {object} options
   * @param {BoundedScrollback} options.scrollback
   * @param {number} options.startMark
   * @param {number} options.timeoutMs
   * @param {number} options.idleSilenceMs
   * @param {number} options.pollIntervalMs
   * @param {() => { kind: string, exitCode?: number|null }} options.statusOf
   * @param {() => void} [options.doWrite] 真正把字节写下去（首次就绪判定之后才调）
   * @param {() => number} [options.sessionQuietMs] 会话已经安静了多久（毫秒）
   * @param {number} [options.awaitReadyTimeoutMs] 首次发送前最多等多久安静（0 = 不等）
   * @param {AbortSignal} [options.signal]
   */
  constructor(options) {
    this.scrollback = options.scrollback
    this.startMark = options.startMark
    this.timeoutMs = options.timeoutMs
    this.idleSilenceMs = options.idleSilenceMs
    this.pollIntervalMs = options.pollIntervalMs
    this.statusOf = options.statusOf
    this.signal = options.signal
    this.doWrite = options.doWrite
    this.sessionQuietMs = options.sessionQuietMs
    this.awaitReadyTimeoutMs = options.awaitReadyTimeoutMs ?? 0

    this.cancelled = false
    this.settled = false
    this.startedAt = Date.now()
    /** 增量缓冲的上限（字符）。 */
    this.deltaLimit = 256 * 1024

    /**
     * 阶段：`waiting`（首次发送前等终端安静）→ `sent`。
     *
     * 不等的话构造时就是 `sent`（后续发送与从前完全一致）。
     */
    this.phase = this.doWrite !== undefined && this.awaitReadyTimeoutMs > 0 ? 'waiting' : 'sent'
    /** 就绪是怎么判定的 —— 如实记下来。 */
    this.readyReason = this.phase === 'sent' ? 'no-wait' : undefined
    /**
     * 我们**真的把字节写下去**的时刻。
     *
     * `waiting` 阶段由 `send()` 设置；不等就绪时（后续发送）构造时就等于开跑时刻
     * —— 与改动前的行为一致。
     */
    this.writeAt = this.phase === 'sent' ? this.startedAt : undefined

    /** @type {(result: object) => void} */
    this.resolveDone = () => {}
    this.rejectDone = () => {}
    /** @type {Promise<object>} */
    this.done = new Promise((resolve, reject) => {
      this.resolveDone = resolve
      this.rejectDone = reject
    })

    /** 上一次看到输出的时间（就绪判定用）。 */
    this.lastOutputAt = Date.now()
    /** 有没有见过任何输出（没见过就别急着判 idle）。 */
    this.sawOutput = false
    /** `readOutput()` 是**消费式**的：读过就清（与宿主一致）。 */
    this.deltaBuffer = ''
    /** 增量有没有因为超界被截掉。 */
    this.deltaTruncated = false

    this.timer = undefined
    this.onAbort = () => this.settle({ waitReason: 'timeout', aborted: true })
  }

  /** 记一次「有新输出」。 */
  noteOutput(text) {
    this.lastOutputAt = Date.now()
    this.sawOutput = true
    if (typeof text === 'string' && text !== '') {
      // 增量缓冲也设个界，避免长时间不读把内存吃光
      this.deltaBuffer += text
      if (this.deltaBuffer.length > this.deltaLimit) {
        this.deltaBuffer = this.deltaBuffer.slice(-this.deltaLimit)
        this.deltaTruncated = true
      }
    }
  }

  /** 开始轮询。 */
  start() {
    if (this.signal?.aborted === true) {
      this.settle({ waitReason: 'timeout', aborted: true })
      return
    }
    this.signal?.addEventListener?.('abort', this.onAbort, { once: true })
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs)
    // 刻意不 unref：这是唯一的结算定时器
  }

  /** 每次轮询检查三种结局。 */
  poll() {
    if (this.settled) return

    // 1) 顶层 shell 退了 —— 最确定的结局
    const status = this.statusOf()
    if (status.kind === 'exited') {
      this.settle({ waitReason: 'session_exit' })
      return
    }

    // 2) 超时
    if (Date.now() - this.startedAt >= this.timeoutMs) {
      this.settle({ waitReason: 'timeout' })
      return
    }

    // 3) 首次发送前：先等终端安静（banner 打完、到了提示符）再写。
    //    这一段**不判「跑完了」** —— 还没写呢，没什么可判的。
    if (this.phase === 'waiting') {
      const quietMs = typeof this.sessionQuietMs === 'function' ? this.sessionQuietMs() : 0
      if (quietMs >= this.idleSilenceMs) {
        this.send({ readyReason: 'quiet' })
      } else if (Date.now() - this.startedAt >= this.awaitReadyTimeoutMs) {
        // 一直不安静也要发（对面可能根本不打任何东西）——
        // 但**如实记下来**，不假装已经就绪
        this.send({ readyReason: 'not-quiet-yet' })
      }
      return
    }

    // 4) 安静够久 —— **推断**（慢命令可能误判，所以上面几个优先）
    //    `since` 取「最后一次输出」与「我们写下去的时刻」的较大值：
    //    写之前的 banner 不该算进这次命令的安静窗口。
    const since = Math.max(this.lastOutputAt, this.writeAt ?? 0)
    if (this.sawOutput && Date.now() - since >= this.idleSilenceMs) {
      this.settle({ waitReason: 'inferred_idle' })
    }
  }

  /** 真正把字节写下去（只在 `waiting` 阶段调用一次）。 */
  send(info = {}) {
    if (this.phase !== 'waiting') return
    this.phase = 'sent'
    this.readyReason = info.readyReason ?? 'quiet'
    // 记下「我们真的写了」的时刻。
    // ⚠️ 刻意**不**重置 `sawOutput` —— 否则不产生任何输出的命令
    // （`true`、`cd`、重定向过的命令）永远等不到 idle，只能走到超时。
    // 用 `writeAt` 参与取最大值就够了：写之前那段输出不算这次命令的。
    this.writeAt = Date.now()
    try {
      this.doWrite?.()
    } catch (error) {
      this.settle({ waitReason: 'write_failed', writeError: error })
    }
  }

  /** 结算。幂等。 */
  settle(info) {
    if (this.settled) return
    this.settled = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.signal?.removeEventListener?.('abort', this.onAbort)

    const status = this.statusOf()
    const viewport = this.scrollback.text()
    this.resolveDone({
      viewport,
      waitReason: info.waitReason,
      sessionStatus: status,
      truncated: this.scrollback.droppedLines > 0,
      aborted: info.aborted === true,
      // 就绪是怎么判定的：`quiet` / `not-quiet-yet` / `no-wait`。
      // 不假装确定 —— 拿不到就如实说。
      readyReason: this.readyReason ?? 'no-wait',
      ...info.writeError === undefined ? {} : { writeError: String(info.writeError?.message ?? info.writeError) },
    })
  }

  /** 放弃等待（不杀进程）。 */
  cancel() {
    if (this.settled) return false
    this.cancelled = true
    this.settle({ waitReason: 'timeout', aborted: true })
    return true
  }

  /** 这次发送之后**还没被读过**的输出（消费式：读过就清）。 */
  readOutput() {
    const delta = this.deltaBuffer
    const truncated = this.deltaTruncated
    this.deltaBuffer = ''
    this.deltaTruncated = false
    return { delta, truncated }
  }
}

/**
 * 一个通用的、与后端无关的终端会话骨架。
 *
 * 三个后端各自实现「怎么把数据送出去」和「怎么结束」，
 * 其余（滚动缓冲、订阅、状态、发送操作）都在这里只写一遍。
 *
 * 子类要实现：
 *   - `_write(data: Buffer)` —— 把字节送到目标侧
 *   - `_resize(cols, rows)` —— 改窗口大小（不支持就空实现）
 *   - `_signal(name)` —— 发信号
 *   - `_close()` —— 真正结束目标侧进程（必须幂等）
 */
export class TerminalSessionBase {
  /**
   * @param {object} options
   * @param {boolean} options.pty 是否真的有 PTY
   * @param {number} [options.pid]
   * @param {Partial<typeof TERMINAL_DEFAULTS>} [options.tuning]
   * @param {string} [options.encoding] 输出编码（默认 utf8）
   */
  constructor(options) {
    this.pty = options.pty === true
    this.pid = options.pid
    this.tuning = { ...TERMINAL_DEFAULTS, ...(options.tuning ?? {}) }
    this.encoding = options.encoding ?? 'utf8'

    this.scrollback = new BoundedScrollback({ maxLines: this.tuning.scrollbackLines })
    /** @type {{ kind: 'running' } | { kind: 'exited', exitCode: number|null, signal: string|null }} */
    this._status = { kind: 'running' }
    this._closed = false
    this._closing = undefined

    /** @type {Set<(chunk: Buffer) => void>} */
    this.dataListeners = new Set()
    /** @type {Set<(info: { exitCode: number|null }) => void>} */
    this.exitListeners = new Set()
    /** @type {SendOperation|undefined} 同一时刻只允许一个发送。 */
    this.activeSend = undefined
    /** 最后一次看到输出的时刻（首次发送前的就绪判定用）。 */
    this.lastOutputAt = undefined
    /** 有没有发送过。**首次**发送要等 banner 打完，之后不用。 */
    this.hasSentOnce = false
  }

  // ── 子类要实现的 ────────────────────────────────────────────────────────

  /** @param {Buffer} _data */
  _write(_data) {
    throw new Error('TerminalSessionBase._write 未实现')
  }

  /** @param {number} _cols @param {number} _rows */
  _resize(_cols, _rows) {}

  /** @param {string} _name */
  async _signal(_name) {
    throw new Error('TerminalSessionBase._signal 未实现')
  }

  async _close() {
    throw new Error('TerminalSessionBase._close 未实现')
  }

  // ── 给子类用的 ──────────────────────────────────────────────────────────

  /** 子类收到输出时调这个。 */
  emitData(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), this.encoding)
    const text = buffer.toString(this.encoding)
    this.lastOutputAt = Date.now()
    this.scrollback.append(text)
    this.activeSend?.noteOutput(text)
    for (const listener of this.dataListeners) {
      try {
        listener(buffer)
      } catch {
        // 订阅者自己的异常不该拖垮会话
      }
    }
  }

  /**
   * 这个会话已经**安静**了多久（毫秒）。
   *
   * 用途：首次发送前判断「banner 打完没有」——见 `TERMINAL_DEFAULTS.awaitReadyTimeoutMs`。
   */
  quietForMs() {
    if (this.lastOutputAt === undefined) return 0
    return Date.now() - this.lastOutputAt
  }

  /** 子类发现进程结束时调这个。幂等。 */
  emitExit(exitCode, signal = null) {
    if (this._status.kind === 'exited') return
    this._status = { kind: 'exited', exitCode: exitCode ?? null, signal: signal ?? null }
    for (const listener of this.exitListeners) {
      try {
        listener({ exitCode: this._status.exitCode })
      } catch {
        // 同上
      }
    }
  }

  // ── 公开契约 ────────────────────────────────────────────────────────────

  /** @param {string|Buffer} data */
  write(data) {
    if (this._status.kind === 'exited') {
      throw new Error('终端已退出，不能再写入')
    }
    this._write(Buffer.isBuffer(data) ? data : Buffer.from(String(data), this.encoding))
  }

  /** @param {number} cols @param {number} rows */
  resize(cols, rows) {
    if (!this.pty) return
    this._resize(cols, rows)
  }

  /** @param {string} name */
  async signal(name) {
    return this._signal(name)
  }

  /** @returns {{ kind: 'running' } | { kind: 'exited', exitCode: number|null }} */
  status() {
    return this._status
  }

  /** 幂等关闭。 */
  async close() {
    if (this._closing !== undefined) return this._closing
    this._closing = (async () => {
      if (this._closed) return
      this._closed = true
      // 立刻结算进行中的发送：`emitExit` 之后轮询本来也会结算（100ms 内），
      // 这一步只是让它**马上**返回 —— 用户关终端时不该再等一个轮询周期。
      this.activeSend?.settle({ waitReason: 'session_exit' })
      await this._close()
      this.emitExit(this._status.kind === 'exited' ? this._status.exitCode : null)
    })()
    return this._closing
  }

  /** @param {(chunk: Buffer) => void} listener */
  onData(listener) {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  /** @param {(info: { exitCode: number|null }) => void} listener */
  onExit(listener) {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /** 分页读滚动缓冲。 */
  read(request = {}) {
    return this.scrollback.read(request)
  }

  /**
   * 开始一次「发送 + 等安静」。
   *
   * 同一时刻只允许一个（与宿主契约一致：第二次会以 `SEND_ACTIVE` 失败）。
   *
   * @param {{ text?: string, submit?: boolean, timeoutMs?: number, signal?: AbortSignal }} request
   * @returns {SendOperation}
   */
  startSend(request = {}) {
    if (this.activeSend !== undefined && !this.activeSend.settled) {
      const error = new Error('这个终端已有一次发送在进行中')
      error.code = 'SEND_ACTIVE'
      throw error
    }

    const text = request.text ?? ''
    const submit = request.submit === true
    const write = () => {
      if (text !== '') this.write(text)
      // `submit` = 再补一个回车（终端要 `\r` 而不是 `\n`）
      if (submit) this.write('\r')
    }

    // **首次**发送要等 banner 打完再写（见 TERMINAL_DEFAULTS.awaitReadyTimeoutMs）；
    // 之后每次直接写 —— 那时 shell 已经在提示符上，「等安静」只会白加延迟。
    const firstSend = this.hasSentOnce !== true
    this.hasSentOnce = true

    const operation = new SendOperation({
      scrollback: this.scrollback,
      startMark: this.scrollback.mark(),
      timeoutMs: request.timeoutMs ?? this.tuning.sendTimeoutMs,
      idleSilenceMs: this.tuning.idleSilenceMs,
      pollIntervalMs: this.tuning.pollIntervalMs,
      statusOf: () => this._status,
      signal: request.signal,
      doWrite: write,
      sessionQuietMs: () => this.quietForMs(),
      awaitReadyTimeoutMs: firstSend ? (request.awaitReadyTimeoutMs ?? this.tuning.awaitReadyTimeoutMs) : 0,
    })
    // 不需要等就绪时（后续发送）立刻写，行为与从前完全一致
    if (operation.phase === 'sent') write()

    this.activeSend = operation
    operation.start()
    operation.done.catch(() => {}).finally(() => {
      if (this.activeSend === operation) this.activeSend = undefined
    })
    return operation
  }

  /** 会话快照（给 `list` 用）。 */
  snapshot(sessionId, name) {
    return {
      sessionId,
      ...name === undefined ? {} : { name },
      type: 'shell',
      ...this.pid === undefined ? {} : { pid: this.pid },
      status: this._status,
    }
  }
}
