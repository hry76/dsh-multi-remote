/**
 * 已连接的**机器**（还没有选定项目目录）。
 *
 * ## 为什么要有这一层
 *
 * 原来的流程是「一次填完」：主机 + 账号 + **远程项目根** → 连接 → 建工作区。
 * 问题：**远程项目根要盲填**。填错了（用户就填成了 `~/新建文件夹`，
 * 而真实位置是 `~/桌面/新建文件夹`）连接照样「成功」，
 * 之后每条命令都切不到目录 —— 排查起来非常费劲。
 *
 * 用户提的流程更对，也正是 VS Code / ZCode 的做法：
 *
 *     先连机器 → 再**看着远程真实目录**点选项目 → 它成为工作区
 *
 * 于是路径不再靠猜。这一层就负责第一步：只建立并持有一条传输层连接，
 * **不拉镜像、不注册预设、不建工作区** —— 那些等选好目录再做。
 *
 * ## 生命周期
 *
 * 浏览用的连接是**短命**的：选好项目后，`machine-open` 会走完整的
 * `connections.connect()`（自己再建一条传输层）。这样两条流程互不纠缠，
 * 浏览连接坏了也不影响已经建好的工作区。
 */
import { posix } from 'node:path'

import { defaultCreateTransport } from './connection.js'
import { TRANSPORT_ERROR } from '../transport/transport.js'

/** 机器 id 里允许的字符（与连接档案 id 同一套规则：**不能含点号**）。 */
function slug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 由「后端 + 目标」推导机器 id。
 *
 * 例：`ssh` + `user@192.0.2.10:22` → `ssh-user-192-0-2-10-22`
 *
 * @param {string} kind
 * @param {string} target
 * @returns {string}
 */
export function deriveMachineId(kind, target) {
  const body = slug(target)
  const base = body === '' ? String(kind ?? 'machine') : `${kind}-${body}`
  return base.slice(0, 60).replace(/-+$/g, '')
}

/** 每种后端连机器时**必填**的字段（项目根不在这里 —— 那是第二步的事）。 */
const REQUIRED_BY_KIND = {
  ssh: ['host', 'username'],
  wsl: ['distro'],
  docker: ['container'],
}

/**
 * 校验「连机器」的输入（**不需要**远程项目根）。
 *
 * 与 `normalizeProfile` 的区别只有一点：这里不要求 `remoteRoot` / `anchorParent`。
 * 白名单式取值，不认识的字段一律丢掉。
 *
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
export function normalizeMachineInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('连接请求必须是一个 JSON 对象')
  }
  const allowed = [
    'kind', 'distro', 'wslUser', 'container', 'dockerPipe',
    'host', 'port', 'username', 'privateKeyPath', 'password', 'passphrase', 'agent', 'label',
  ]
  const input = {}
  for (const key of allowed) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed !== '') input[key] = trimmed
      continue
    }
    if (key === 'port' && typeof value === 'number' && Number.isFinite(value)) input.port = value
  }

  const kind = typeof input.kind === 'string' ? input.kind : 'ssh'
  if (!Object.hasOwn(REQUIRED_BY_KIND, kind)) {
    throw new Error(`不支持的后端类型：${kind}（可选：ssh / wsl / docker）`)
  }
  input.kind = kind
  for (const field of REQUIRED_BY_KIND[kind]) {
    if (typeof input[field] !== 'string' || input[field] === '') {
      throw new Error(`后端 ${kind} 缺少必填字段：${field}`)
    }
  }
  if (kind === 'ssh') {
    const hasAuth = ['privateKeyPath', 'password', 'agent'].some((key) => typeof input[key] === 'string' && input[key] !== '')
    if (!hasAuth) throw new Error('SSH 至少要提供一种认证方式：私钥路径 / 密码 / agent')
    const port = input.port === undefined ? 22 : Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口必须是 1–65535 的整数：${String(input.port)}`)
    input.port = port
  }
  return input
}

/** 机器在界面上的显示名。 */
export function describeMachine(machine) {
  const target = machine.kind === 'wsl'
    ? `WSL ${machine.profile.distro}`
    : machine.kind === 'docker'
      ? `容器 ${machine.profile.container}`
      : `${machine.profile.username}@${machine.profile.host}:${machine.profile.port}`
  return {
    id: machine.id,
    kind: machine.kind,
    label: machine.label,
    target,
    home: machine.home,
  }
}

/** 一台已连接的机器。 */
class Machine {
  constructor({ id, label, profile, transport, home }) {
    this.id = id
    this.label = label
    this.kind = profile.kind
    this.profile = profile
    this.transport = transport
    this.home = home
    this.connectedAt = Date.now()
  }
}

/**
 * 机器注册表：连上但还没选项目的机器。
 */
export class MachineRegistry {
  /**
   * @param {object} [options]
   * @param {Function} [options.createTransport] 传输层工厂（测试注入用）
   * @param {object} [options.knownHosts]
   * @param {(info: object) => boolean|void} [options.confirmHostKey]
   * @param {(message: string, ...rest: unknown[]) => void} [options.log]
   */
  constructor(options = {}) {
    this.createTransport = options.createTransport ?? defaultCreateTransport
    this.knownHosts = options.knownHosts
    this.confirmHostKey = options.confirmHostKey
    this.log = options.log
    /** @type {Map<string, Machine>} */
    this.machines = new Map()
  }

  /**
   * 连一台机器（不建项目）。
   *
   * @param {unknown} raw
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<object>} `describeMachine()` 的结果
   */
  async connect(raw, options = {}) {
    const input = normalizeMachineInput(raw)
    const target = input.kind === 'wsl'
      ? input.distro
      : input.kind === 'docker'
        ? input.container
        : `${input.username}@${input.host}:${input.port}`
    const id = deriveMachineId(input.kind, target)

    // 同一台机器重复连 → 复用已有连接（用户多点一次不该报错）
    const existing = this.machines.get(id)
    if (existing !== undefined) return describeMachine(existing)

    const profile = {
      id,
      kind: input.kind,
      distro: input.distro,
      wslUser: input.wslUser,
      container: input.container,
      dockerPipe: input.dockerPipe,
      host: input.host,
      port: input.port,
      username: input.username,
      privateKeyPath: input.privateKeyPath,
      password: input.password,
      passphrase: input.passphrase,
      agent: input.agent,
    }

    const transport = this.createTransport(profile, {
      log: this.log,
      knownHosts: this.knownHosts,
      confirmHostKey: this.confirmHostKey,
    })
    await transport.connect()

    // 起始目录：远程的 $HOME。拿不到就退回 `/`（**不猜一个假路径**）。
    let home = '/'
    try {
      const run = await transport.exec('printf %s "$HOME"', { signal: options.signal })
      const text = String(run?.stdout ?? '').trim()
      if (text.startsWith('/')) home = text
    } catch {
      // 拿不到 HOME 不算失败 —— 从根目录开始浏览就是了
    }

    const machine = new Machine({
      id,
      label: typeof input.label === 'string' && input.label !== '' ? input.label : target,
      profile,
      transport,
      home,
    })
    this.machines.set(id, machine)
    return describeMachine(machine)
  }

  /** 取一台机器（拿不到就是 undefined —— 不抛错，调用方自己决定怎么说）。 */
  get(id) {
    return this.machines.get(id)
  }

  /** 界面用：当前连着哪些机器。 */
  list() {
    return [...this.machines.values()].map(describeMachine)
  }

  /**
   * 列一层远程目录（浏览用）。
   *
   * **只列一层**，并且把目录排在前面 —— 用户是来「点进一个文件夹」的。
   * 上层目录在本地算（`posix.dirname`），不额外往返。
   *
   * @param {string} id
   * @param {string} path
   * @param {{ signal?: AbortSignal }} [options]
   */
  async listDir(id, path, options = {}) {
    const machine = this.machines.get(id)
    if (machine === undefined) throw new Error(`没有名为 ${id} 的已连接机器（可能已经断开，请重新连接）`)

    const target = typeof path === 'string' && path.trim() !== '' ? path.trim() : machine.home
    if (!target.startsWith('/')) throw new Error(`路径必须是绝对路径：${target}`)

    let entries
    try {
      entries = await machine.transport.readdir(target, { signal: options.signal })
    } catch (error) {
      if (error?.code === TRANSPORT_ERROR.NOT_FOUND) throw new Error(`目录不存在：${target}`)
      throw error
    }

    const dirs = []
    const files = []
    for (const entry of entries ?? []) {
      const name = String(entry?.name ?? '')
      if (name === '' || name === '.' || name === '..') continue
      const isDir = entry?.type === 'directory' || entry?.type === 'dir'
      const item = { name, type: isDir ? 'dir' : 'file' }
      if (isDir) dirs.push(item)
      else files.push(item)
    }
    const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')
    dirs.sort(byName)
    files.sort(byName)

    const parent = posix.dirname(target)
    return {
      path: target,
      parent: parent === target ? null : parent,
      dirs,
      // 文件只回**数量**：用户是来选文件夹的，回一长串文件名只会刷屏
      fileCount: files.length,
    }
  }

  /** 断开一台机器（浏览用的连接）。 */
  async disconnect(id) {
    const machine = this.machines.get(id)
    if (machine === undefined) return false
    this.machines.delete(id)
    try {
      await machine.transport.disconnect()
    } catch (error) {
      // 断开失败不影响「已经断开」这个事实，但要留痕
      this.log?.('断开机器 %s 时出错：%s', id, String(error?.message ?? error))
    }
    return true
  }

  /** 全部断开（插件卸载时用）。**一台失败不影响其他**。 */
  async disconnectAll() {
    const ids = [...this.machines.keys()]
    const results = await Promise.all(ids.map((id) => this.disconnect(id).catch(() => false)))
    return results.filter(Boolean).length
  }
}
