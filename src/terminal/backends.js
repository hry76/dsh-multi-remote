/**
 * 三个后端的**交互式终端**实现。
 *
 * 每个后端拿 PTY 的方式都不同，但拿到之后的会话契约是同一个
 * （见 `./session.js` 的 {@link TerminalSessionBase}）。所以这里每个后端只有一小段：
 * 「怎么开」「怎么送字节」「怎么发信号」「怎么结束」。
 *
 * ## 各后端的能力差异（实测，不猜）
 *
 * | 后端 | PTY 来源 | 窗口大小 | 发信号 |
 * |---|---|---|---|
 * | SSH | ssh2 的 `shell()` 通道 | `setWindow` ✅ | ✅（进程组） |
 * | Docker | `exec` + `Tty: true`（raw stream） | `resize` 端点 ✅ | ✅（在容器内 `kill`） |
 * | WSL | `wsl.exe -e script -qec <cmd> /dev/null` | ❌（`script` 固定大小） | ✅（在发行版内 `kill`） |
 *
 * WSL 那条需要 `script`（util-linux）。**缺失时明确失败，不假装有 PTY** ——
 * 一个没有 PTY 的「终端」会在 `sudo`、密码输入、`top` 这类场景静默出问题。
 */
import { spawn as spawnProcess } from 'node:child_process'
import http from 'node:http'

import { TransportError, TRANSPORT_ERROR } from '../transport/transport.js'
import { TerminalSessionBase } from './session.js'
import { shellQuote } from './quote.js'

/** 默认终端尺寸。 */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const DEFAULT_TERM = 'xterm-256color'

// ── SSH ─────────────────────────────────────────────────────────────────────

/**
 * SSH 终端：用 ssh2 的 `shell()` 开一个真正的 PTY 通道。
 *
 * 这是三个后端里最干净的 —— ssh2 原生支持 PTY 与 `setWindow`。
 */
export class SshTerminalSession extends TerminalSessionBase {
  /**
   * @param {object} options
   * @param {import('ssh2').ClientChannel} options.channel
   * @param {number} [options.pid] 拿不到（SSH 不报告 shell 的 pid）
   */
  constructor(options) {
    super({ pty: true, pid: options.pid })
    this.channel = options.channel
    this.channel.on('data', (chunk) => this.emitData(chunk))
    // SSH 把 stderr 单独给一路；终端里两路都该显示出来
    this.channel.stderr?.on('data', (chunk) => this.emitData(chunk))
    this.channel.on('close', (code) => this.emitExit(typeof code === 'number' ? code : null))
    this.channel.on('exit', (code) => this.emitExit(typeof code === 'number' ? code : null))
  }

  _write(data) {
    this.channel.write(data)
  }

  _resize(cols, rows) {
    this.channel.setWindow(rows, cols, 0, 0)
  }

  async _signal(name) {
    // SSH 通道本身没有「发信号」原语，靠终端控制字符：
    // Ctrl-C = 0x03、Ctrl-Z = 0x1a、Ctrl-\ = 0x1c
    const control = { SIGINT: '\x03', SIGTSTP: '\x1a', SIGQUIT: '\x1c' }[name]
    if (control !== undefined) {
      this.channel.write(control)
      return
    }
    // 其余信号只能靠关闭通道（SIGHUP 语义）
    if (name === 'SIGHUP' || name === 'SIGTERM' || name === 'SIGKILL') {
      this.channel.close()
      return
    }
    throw new TransportError(TRANSPORT_ERROR.UNKNOWN, `SSH 终端不支持发送 ${name}`, { operation: 'signal' })
  }

  async _close() {
    try {
      this.channel.close()
    } catch {
      // 已经关了
    }
  }
}

// ── Docker ──────────────────────────────────────────────────────────────────

/**
 * Docker 终端：`exec` + `Tty: true`。
 *
 * 与 `DockerTransport.#execRaw` 的关键区别：`Tty: true` 时输出是**裸流**
 * （没有 8 字节多路复用头），而且连接是 **hijack** 的 ——
 * 所以不能用普通的「发完请求等响应」模式，必须处理 `upgrade` 事件。
 */
export class DockerTerminalSession extends TerminalSessionBase {
  /**
   * @param {object} options
   * @param {string} options.execId
   * @param {import('node:net').Socket} options.socket
   * @param {import('../transport/docker.js').DockerClient} options.client
   * @param {string} options.container
   * @param {number} [options.pid]
   */
  constructor(options) {
    super({ pty: true, pid: options.pid })
    this.execId = options.execId
    this.socket = options.socket
    this.client = options.client
    this.container = options.container

    this.socket.on('data', (chunk) => this.emitData(chunk))
    this.socket.on('close', () => this.#pollExit())
    this.socket.on('error', () => this.#pollExit())
    // exec 退出后 socket 会关；退出码得问 API
    this.exitPoll = setInterval(() => this.#pollExit(), 300)
    // 刻意不 unref：会话活着时它必须能继续推进
  }

  /** 轮询退出码（Docker 的 exec 退出码只能从 API 拿）。 */
  async #pollExit() {
    if (this.status().kind === 'exited') {
      clearInterval(this.exitPoll)
      return
    }
    try {
      const inspected = await this.client.inspectExec(this.execId)
      const value = inspected.value
      if (value?.Running === false && value?.ExitCode !== null && value?.ExitCode !== undefined) {
        clearInterval(this.exitPoll)
        this.emitExit(Number(value.ExitCode))
      }
    } catch {
      // 守护进程暂时不可达；下一次再试
    }
  }

  _write(data) {
    this.socket.write(data)
  }

  _resize(cols, rows) {
    // 不 await：resize 是尽力而为，失败不该打断输入
    this.client.resizeExec(this.execId, cols, rows).catch(() => {})
  }

  async _signal(name) {
    // ⚠️ 有 PTY 时，正确的做法是**往终端里写控制字符**，而不是去 `kill` 某个 pid。
    // 理由：PTY 的行规程（line discipline）会把 Ctrl-C 自动变成 SIGINT 发给
    // **前台进程组** —— 这正是终端的语义，也自然覆盖 `sleep 30` 这种前台子进程。
    // 自己去找 pgid 再 kill 反而不可靠：容器里未必有 `ps`，而且容易杀错组。
    const control = { SIGINT: '\x03', SIGTSTP: '\x1a', SIGQUIT: '\x1c' }[name]
    if (control !== undefined) {
      this.socket.write(control)
      return
    }
    // 其余信号没有对应的控制字符，只能关掉连接（SIGHUP 语义）
    if (name === 'SIGHUP' || name === 'SIGTERM' || name === 'SIGKILL') {
      this.socket.destroy()
      return
    }
    throw new TransportError(TRANSPORT_ERROR.UNKNOWN, `Docker 终端不支持发送 ${name}`, {
      operation: 'signal',
    })
  }

  async _close() {
    clearInterval(this.exitPoll)
    try {
      this.socket.destroy()
    } catch {
      // 已经关了
    }
  }
}

// ── WSL ─────────────────────────────────────────────────────────────────────

/**
 * WSL 终端：`wsl.exe -e script -qec <cmd> /dev/null`。
 *
 * `wsl.exe` 自己不给 PTY，但 util-linux 的 `script` 能在发行版内部开一个真 PTY。
 * 实测：`script -qec "tty" /dev/null` → `/dev/pts/2`、`TERM=xterm-256color`。
 *
 * **`script` 缺失时明确失败**（有些精简发行版没有 util-linux）。
 * 窗口大小没法传（`script` 不支持），所以 `resize` 是空操作 —— 这是如实的能力差异，
 * 不是 bug。
 */
export class WslTerminalSession extends TerminalSessionBase {
  /**
   * @param {object} options
   * @param {import('node:child_process').ChildProcess} options.child
   */
  constructor(options) {
    super({ pty: true })
    this.child = options.child
    this.child.stdout?.on('data', (chunk) => this.emitData(chunk))
    // PTY 会把 stderr 并进 stdout（终端本来就是一路）；但保险起见也接上
    this.child.stderr?.on('data', (chunk) => this.emitData(chunk))
    this.child.on('exit', (code) => this.emitExit(typeof code === 'number' ? code : null))
    this.child.on('error', () => this.emitExit(null))
  }

  _write(data) {
    this.child.stdin?.write(data)
  }

  /** `script` 不支持在运行中改窗口大小 —— 如实空实现。 */
  _resize() {}

  async _signal(name) {
    // 与 Docker 同一条理由：有 PTY 就走控制字符，让行规程把 Ctrl-C 变成
    // 发给前台进程组的 SIGINT。`script` 分配的 PTY 同样支持这套语义。
    const control = { SIGINT: '\x03', SIGTSTP: '\x1a', SIGQUIT: '\x1c' }[name]
    if (control !== undefined) {
      this.child.stdin?.write(control)
      return
    }
    if (name === 'SIGHUP' || name === 'SIGTERM' || name === 'SIGKILL') {
      try {
        this.child.stdin?.end()
      } catch {
        // 已经关了
      }
      // 温和终止 wsl.exe（**绝不 SIGKILL** —— 实测会把 relay 打死）
      try {
        this.child.kill('SIGTERM')
      } catch {
        // 已经退了
      }
      return
    }
    throw new TransportError(TRANSPORT_ERROR.UNKNOWN, `WSL 终端不支持发送 ${name}`, {
      operation: 'signal',
    })
  }

  async _close() {
    try {
      this.child.stdin?.end()
    } catch {
      // 已经关了
    }
    // 温和终止 wsl.exe（**绝不 SIGKILL** —— 实测会把 relay 打死）
    try {
      this.child.kill('SIGTERM')
    } catch {
      // 已经退了
    }
  }
}

// ── 工厂 ────────────────────────────────────────────────────────────────────

/**
 * 为 SSH transport 开一个终端。
 * @param {import('../transport/ssh.js').SshTransport} transport
 * @param {object} spec
 */
export async function spawnSshTerminal(transport, spec = {}) {
  // 死通道直接报错。**刻意不重连** —— 重连等于静默换一个新 shell，
  // 用户会以为自己还在原来那个会话里（那是谎报状态，比报错更坏）。
  // 判定只留这一处：`assertAlive` 就是「通道死了没有」的唯一真相来源，
  // 这里再手写一遍判断只会两边漂移（之前就是这么错的）。
  transport.assertAlive('SSH 连接不可用，无法开终端（通道已死或尚未连接）')

  const cols = spec.cols ?? DEFAULT_COLS
  const rows = spec.rows ?? DEFAULT_ROWS
  const term = spec.term ?? DEFAULT_TERM

  const channel = await new Promise((resolve, reject) => {
    const options = {
      term,
      cols,
      rows,
      width: cols * 8,
      height: rows * 16,
      ...spec.cwd === undefined ? {} : { cwd: spec.cwd },
    }
    transport.client.shell(options, (error, value) => (error ? reject(error) : resolve(value)))
  })

  // 有初始命令时，把它打进 shell（而不是替换 shell）——
  // 这样终端仍然是「用户的 shell」，命令跑完还能继续用。
  if (typeof spec.command === 'string' && spec.command.trim() !== '') {
    channel.write(`${spec.command}\r`)
  }
  return new SshTerminalSession({ channel })
}

/**
 * 为 Docker transport 开一个终端。
 * @param {import('../transport/docker.js').DockerTransport} transport
 * @param {object} spec
 */
export async function spawnDockerTerminal(transport, spec = {}) {
  if (transport.containerRunning !== true) {
    throw new TransportError(
      TRANSPORT_ERROR.CONNECT_FAILED,
      `容器 "${transport.container}" 没有在运行，无法开终端`,
      { operation: 'spawnTerminal', retryable: true },
    )
  }
  transport.requireExec?.('开终端', transport.container)

  const cols = spec.cols ?? DEFAULT_COLS
  const rows = spec.rows ?? DEFAULT_ROWS
  const shell = transport.shell ?? 'sh'
  const command = typeof spec.command === 'string' && spec.command.trim() !== ''
    ? [shell, '-c', spec.command]
    : [shell, '-l']

  const execId = await transport.client.createExec(transport.container, {
    Cmd: command,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    ...spec.cwd === undefined ? {} : { WorkingDir: spec.cwd },
    ...spec.env === undefined ? {} : { Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`) },
  })

  const socket = await transport.client.startExecTty(execId, { signal: spec.signal })
  return new DockerTerminalSession({ execId, socket, client: transport.client, container: transport.container })
}

/**
 * 为 WSL transport 开一个终端。
 *
 * 用 `script -qec` 在发行版内部拿 PTY。**`script` 不在就明确报错**，
 * 不退化成一个「看起来像终端但没有 PTY」的管道。
 *
 * @param {import('../transport/wsl.js').WslTransport} transport
 * @param {object} spec
 */
export async function spawnWslTerminal(transport, spec = {}) {
  const cols = spec.cols ?? DEFAULT_COLS
  const rows = spec.rows ?? DEFAULT_ROWS
  const term = spec.term ?? DEFAULT_TERM

  // 先确认 script 存在 —— 缺失就明确失败，别给一个假终端
  const probe = await transport.exec('command -v script >/dev/null 2>&1 && echo YES || echo NO')
  if (!probe.stdout.includes('YES')) {
    throw new TransportError(
      TRANSPORT_ERROR.UNKNOWN,
      `发行版 "${transport.distro}" 里没有 util-linux 的 \`script\`，` +
      '无法分配 PTY。这个后端不能提供交互式终端（不退化成一个没有 PTY 的假终端）。',
      { operation: 'spawnTerminal', target: transport.distro, retryable: false },
    )
  }

  // 把用户命令放进一个临时包装脚本，避免任何引号问题：
  // 传给 script 的只有一个我们自己生成的路径。
  const marker = Math.random().toString(36).slice(2, 10)
  const wrapper = `/tmp/.dsh-mr-term-${marker}.sh`
  const inner = typeof spec.command === 'string' && spec.command.trim() !== ''
    ? spec.command
    : 'exec "${SHELL:-/bin/bash}" -l'

  const write = await transport.exec(
    `printf '%s\\n' ${shellQuote(`# DSHMR-TERM-${marker}`)} ${shellQuote(inner)} > ${shellQuote(wrapper)} && echo WROTE`,
  )
  if (!write.stdout.includes('WROTE')) {
    throw new TransportError(TRANSPORT_ERROR.UNKNOWN, `无法写入终端包装脚本：${write.stderr}`, {
      operation: 'spawnTerminal',
    })
  }

  // script -qec <command> <typescript-file>：把会话记录丢掉，只留 PTY
  const argv = [
    '-d', transport.distro,
    ...transport.username === undefined ? [] : ['-u', transport.username],
    ...spec.cwd === undefined ? [] : ['--cd', String(spec.cwd)],
    '-e', 'env', `TERM=${term}`, `COLUMNS=${cols}`, `LINES=${rows}`,
    'script', '-qec', `sh ${wrapper}`, '/dev/null',
  ]

  const child = spawnProcess(transport.wslExeCommand ?? 'wsl.exe', argv, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const session = new WslTerminalSession({ child })
  // 让信号处理能按标记找到这个终端的进程
  session.marker = marker
  session.runner = (command) => transport.exec(command)
  return session
}

/**
 * 按 transport 的 kind 分发。
 *
 * @param {import('../transport/transport.js').Transport} transport
 * @param {object} spec
 * @returns {Promise<import('./session.js').TerminalSessionBase|undefined>}
 */
export async function spawnTerminal(transport, spec = {}) {
  switch (transport.kind) {
    case 'ssh':
      return spawnSshTerminal(transport, spec)
    case 'docker':
      return spawnDockerTerminal(transport, spec)
    case 'wsl':
      return spawnWslTerminal(transport, spec)
    default:
      // 不认识的后端：如实返回「不支持」，不假装能开
      return undefined
  }
}
