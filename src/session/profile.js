/**
 * 连接档案 —— 描述「连哪台机器、以谁的身份、项目根在哪」。
 *
 * 这是插件**唯一的配置入口**：先用 `remote_connect` 工具（或界面弹窗）建立连接，
 * 之后的流程就变成「先选远程工作区（= 锚点目录）→ 再建会话」，
 * 会话自动用上我们的预设（时机约束见 `binder.js`）。
 *
 * ## 凭据处理（硬约束）
 *
 * - **不落明文**：档案只存**引用**（私钥路径、agent socket），不存口令与私钥正文。
 * - **不回显**：`describeProfile()` 给界面 / 模型看的版本会剥掉敏感字段。
 * - **文件权限 `0600`**：写入时带 `mode` 并显式 `chmod`（见 `saveProfile`）。
 *   ⚠️ Windows 上 `chmod` 只影响只读位，真正的访问控制由用户目录的 ACL 决定 ——
 *   这里**不假装**它等价于 POSIX 的 `0600`。
 */
import { isAbsolute, join } from 'node:path'

/** 连接档案的必填/可选字段与校验规则。 */
export const PROFILE_FIELDS = {
  /** 档案标识：用于派生预设 id 与锚点目录名。必填且全局唯一。 */
  id: { required: true, type: 'string' },
  /** 显示名（给界面看）。 */
  label: { required: false, type: 'string' },
  /**
   * 后端类型。`'ssh'`（默认）/ `'wsl'` / `'docker'`。
   *
   * 三者的字段需求差别很大：WSL 与 Docker 都是**本机进程/守护进程**，
   * **不需要任何凭据**；只有 SSH 需要认证信息。
   */
  kind: { required: false, type: 'string', default: 'ssh' },
  /**
   * **机器级档案**：只记「连过哪台机器」，**没有项目根**。
   *
   * 界面里「用过的连接」用的就是它 —— 第一步只需要主机 / 账号 / 私钥路径，
   * 项目根是第二步（看着远程目录点选）才有的。置 `true` 时
   * `remoteRoot` / `anchorParent` **允许缺失**。
   */
  machine: { required: false, type: 'boolean', default: false },
  /** WSL 发行版名（`kind: 'wsl'` 时必填，例如 `Ubuntu-24.04`）。 */
  distro: { required: false, type: 'string' },
  /** WSL 里以哪个 Linux 用户执行（可选，默认发行版默认用户）。 */
  wslUser: { required: false, type: 'string' },
  /** Docker 容器名或 id（`kind: 'docker'` 时必填，**必须已在运行**）。 */
  container: { required: false, type: 'string' },
  /** Docker 命名管道（可选，默认自动探测 Docker Desktop / 经典管道）。 */
  dockerPipe: { required: false, type: 'string' },
  /** SSH 主机（`kind: 'ssh'` 时必填）。 */
  host: { required: false, type: 'string' },
  port: { required: false, type: 'number', default: 22 },
  /** SSH 登录账号（`kind: 'ssh'` 时必填）。 */
  username: { required: false, type: 'string' },
  /** 私钥路径。与 `privateKey`（内联内容）二选一。 */
  privateKeyPath: { required: false, type: 'string' },
  /** 私钥内容（调用方自己从安全来源读；本模块不落盘）。 */
  privateKey: { required: false, type: 'string' },
  /** 私钥口令（若有）。 */
  passphrase: { required: false, type: 'string' },
  /** 登录口令（若有）。**只在内存里用，不写进档案。** */
  password: { required: false, type: 'string' },
  /** SSH agent socket。**只有显式给出才启用** —— 否则密码登录会被公钥耗尽认证次数。 */
  agent: { required: false, type: 'string' },
  /** 是否允许 keyboard-interactive（部分服务端只开这个）。 */
  tryKeyboard: { required: false, type: 'boolean', default: false },
  /** 远程项目根（绝对 POSIX 路径）。锚点镜像的就是它。 */
  remoteRoot: { required: true, type: 'string' },
  /** 锚点目录的父目录（本地绝对路径）。 */
  anchorParent: { required: true, type: 'string' },
}

/** 档案校验失败。 */
export class ProfileError extends Error {
  constructor(message, problems = []) {
    super(message)
    this.name = 'ProfileError'
    this.problems = problems
  }
}

/**
 * 校验并规范化一个连接档案。
 *
 * 刻意**不做任何补全猜测**：远程根必须是绝对 POSIX 路径（目标环境一律 POSIX），
 * 锚点父目录必须是本地绝对路径。猜错这两者会让镜像写到意外的地方。
 *
 * @param {object} input
 * @returns {object} 规范化后的档案（含默认值）
 * @throws {ProfileError}
 */
export function normalizeProfile(input) {
  const problems = []
  const profile = {}

  if (typeof input !== 'object' || input === null) {
    throw new ProfileError('连接档案必须是对象', ['input 不是对象'])
  }

  // id：不能含点号（会进预设 id，参考项目实测含点号会让插件树加载失败）
  const id = String(input.id ?? '').trim()
  if (id === '') problems.push('id 必填')
  else if (id.includes('.')) problems.push(`id 不能含点号：${id}`)
  profile.id = id

  profile.label = typeof input.label === 'string' && input.label.trim() !== '' ? input.label.trim() : id

  // 后端类型：只支持 ssh / wsl / docker。**不做猜测** —— 猜错会连到完全不同的地方。
  const kind = String(input.kind ?? PROFILE_FIELDS.kind.default).trim().toLowerCase()
  if (kind !== 'ssh' && kind !== 'wsl' && kind !== 'docker') {
    problems.push(`kind 只支持 'ssh' / 'wsl' / 'docker'，得到：${input.kind}`)
  }
  profile.kind = kind

  if (kind === 'wsl') {
    // ── WSL：本机进程，**不需要任何凭据**，只要发行版名 ────────────────
    const distro = String(input.distro ?? '').trim()
    if (distro === '') problems.push("kind='wsl' 时 distro 必填（例如 Ubuntu-24.04）")
    profile.distro = distro
    if (typeof input.wslUser === 'string' && input.wslUser.trim() !== '') {
      profile.wslUser = input.wslUser.trim()
    }
    // host/port/username 对 WSL 没有意义 —— 显式清掉，避免档案里留半截字段
    profile.host = undefined
    profile.port = undefined
    profile.username = undefined
  } else if (kind === 'docker') {
    // ── Docker：守护进程 + 已运行的容器，**也不需要凭据** ──────────────
    const container = String(input.container ?? '').trim()
    if (container === '') problems.push("kind='docker' 时 container 必填（容器名或 id，必须已在运行）")
    profile.container = container
    if (typeof input.dockerPipe === 'string' && input.dockerPipe.trim() !== '') {
      profile.dockerPipe = input.dockerPipe.trim()
    }
    profile.host = undefined
    profile.port = undefined
    profile.username = undefined
  } else {
    // ── SSH：主机 + 账号 + 至少一种认证 ────────────────────────────────
    const host = String(input.host ?? '').trim()
    if (host === '') problems.push('host 必填')
    profile.host = host

    const port = input.port === undefined ? PROFILE_FIELDS.port.default : Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`port 必须是 1..65535 的整数：${input.port}`)
    profile.port = port

    const username = String(input.username ?? '').trim()
    if (username === '') problems.push('username 必填')
    profile.username = username

    // 认证方式：至少要有一个
    const hasKeyPath = typeof input.privateKeyPath === 'string' && input.privateKeyPath.trim() !== ''
    const hasKeyInline = typeof input.privateKey === 'string' && input.privateKey.trim() !== ''
    const hasPassword = typeof input.password === 'string' && input.password !== ''
    const hasAgent = typeof input.agent === 'string' && input.agent.trim() !== ''
    if (!hasKeyPath && !hasKeyInline && !hasPassword && !hasAgent) {
      problems.push('至少要提供一种认证方式：privateKeyPath / privateKey / password / agent')
    }
    if (hasKeyPath) profile.privateKeyPath = String(input.privateKeyPath).trim()
    if (hasKeyInline) profile.privateKey = input.privateKey
    if (typeof input.passphrase === 'string' && input.passphrase !== '') profile.passphrase = input.passphrase
    if (hasPassword) profile.password = input.password
    if (hasAgent) profile.agent = String(input.agent).trim()
    profile.tryKeyboard = input.tryKeyboard === true
  }

  // 远程根：必须是绝对 POSIX 路径。**不猜、不补全。**
  //
  // ⚠️ **机器级档案没有项目根**（`machine: true`）—— 那是第二步选出来的。
  // 只有「连到项目」用的档案才要求它；否则界面就没法记住「连过哪台机器」，
  // 用户每次都要把主机、账号、私钥路径重敲一遍（实测反馈）。
  if (input.machine === true) {
    profile.machine = true
  } else {
    const remoteRoot = String(input.remoteRoot ?? '').trim()
    if (remoteRoot === '') problems.push('remoteRoot 必填')
    else if (!remoteRoot.startsWith('/')) {
      problems.push(`remoteRoot 必须是以 / 开头的绝对 POSIX 路径（目标环境一律 POSIX）：${remoteRoot}`)
    }
    profile.remoteRoot = remoteRoot

    // 锚点父目录：必须是本地绝对路径
    const anchorParent = String(input.anchorParent ?? '').trim()
    if (anchorParent === '') problems.push('anchorParent 必填（锚点目录放哪）')
    else if (!isAbsolute(anchorParent)) {
      problems.push(`anchorParent 必须是绝对路径：${anchorParent}`)
    }
    profile.anchorParent = anchorParent
  }

  if (problems.length > 0) {
    throw new ProfileError(`连接档案有问题：${problems.join('；')}`, problems)
  }
  return profile
}

/**
 * 给界面 / 模型看的档案描述 —— **剥掉一切敏感字段**。
 *
 * 存在的理由：任何要进日志、进工具输出、进 UI 的东西都必须走这里，
 * 这样「口令泄漏到某处」就只能通过「绕过这个函数」发生，而不是靠人记得删。
 *
 * @param {object} profile
 * @returns {object}
 */
export function describeProfile(profile) {
  const base = {
    id: profile.id,
    label: profile.label,
    kind: profile.kind ?? 'ssh',
    remoteRoot: profile.remoteRoot,
    anchorParent: profile.anchorParent,
  }

  // WSL / Docker：都是本机侧的，没有凭据可言，字段也少
  if (base.kind === 'wsl') {
    return {
      ...base,
      distro: profile.distro,
      wslUser: profile.wslUser ?? null,
      auth: { kind: 'wsl', note: '本机进程，不需要凭据' },
    }
  }
  if (base.kind === 'docker') {
    return {
      ...base,
      container: profile.container,
      auth: { kind: 'docker', note: '本机守护进程，不需要凭据' },
    }
  }

  return {
    ...base,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    auth: {
      // 只说「用什么方式」，绝不给值
      privateKeyPath: profile.privateKeyPath === undefined ? null : '(已配置路径)',
      privateKey: profile.privateKey === undefined ? null : '(已配置内容)',
      password: profile.password === undefined ? null : '(已配置，不回显)',
      agent: profile.agent === undefined ? null : '(已配置 socket)',
      tryKeyboard: profile.tryKeyboard === true,
    },
  }
}

/** 档案里出现过的敏感键名（用于断言「没被写进日志」）。 */
export const SENSITIVE_PROFILE_KEYS = ['password', 'privateKey', 'passphrase']

/**
 * 断言一段文本里没有凭据泄漏。测试与日志出口都用它。
 * @param {string} text
 * @param {object} profile
 * @returns {string[]} 命中的敏感值（空数组表示干净）
 */
export function findLeakedSecrets(text, profile) {
  const haystack = String(text ?? '')
  const hits = []
  for (const key of SENSITIVE_PROFILE_KEYS) {
    const value = profile?.[key]
    if (typeof value === 'string' && value !== '' && haystack.includes(value)) hits.push(key)
  }
  return hits
}

/** 锚点目录的完整路径（`anchorParent` + 派生目录名）。 */
export function anchorPathOf(profile, directoryName) {
  return join(profile.anchorParent, directoryName)
}

// ── 档案持久化 ──────────────────────────────────────────────────────────────
//
// **非敏感字段落盘，凭据不落盘** —— 这是**有意划出的边界**，不是没做完：
//   - 落盘：id / label / host / port / username / remoteRoot / anchorParent / 私钥**路径** / tryKeyboard
//   - 不落盘：password / privateKey（内联内容）/ passphrase / agent socket
//   - 文件权限 0600（尽力而为：Windows 上 POSIX 权限位不生效，但不因此拒绝保存）
//
// 这样「重连」不用重新敲一遍主机与路径，而口令仍然每次现给。
// **不做钥匙串 / 凭据 seam**：那要引入平台相关的凭据存储，收益（省一次输入）
// 与代价（多一个平台依赖、多一处可能泄漏的落点）不成比例。

/** 档案存储目录。 */
export const PROFILE_STORE_DIR = 'profiles'

/** 落盘时**必须剥掉**的字段。 */
export const NON_PERSISTED_KEYS = ['password', 'privateKey', 'passphrase', 'agent']

/**
 * 剥出可安全落盘的部分。
 *
 * @param {object} profile 规范化后的档案
 * @returns {object}
 */
export function persistableProfile(profile) {
  const safe = {}
  for (const [key, value] of Object.entries(profile)) {
    if (NON_PERSISTED_KEYS.includes(key)) continue
    if (value === undefined) continue
    safe[key] = value
  }
  return safe
}

/**
 * 把档案存到磁盘（只存非敏感字段）。
 *
 * @param {string} storeDir 存储目录（通常是 `<DSH_HOME>/multi-remote/profiles`）
 * @param {object} profile 规范化后的档案
 * @returns {Promise<{ path: string, persisted: string[], stripped: string[] }>}
 */
export async function saveProfile(storeDir, profile) {
  const { mkdir, writeFile, chmod } = await import('node:fs/promises')
  await mkdir(storeDir, { recursive: true })
  const safe = persistableProfile(profile)
  const file = join(storeDir, `${safe.id}.json`)
  await writeFile(file, `${JSON.stringify(safe, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  // 已存在的文件不会被上面的 mode 改权限，显式再来一次；失败不致命（Windows 上无意义）
  await chmod(file, 0o600).catch(() => {})
  return {
    path: file,
    persisted: Object.keys(safe),
    stripped: Object.keys(profile).filter((key) => NON_PERSISTED_KEYS.includes(key)),
  }
}

/**
 * 读一个已保存的档案。
 *
 * @param {string} storeDir
 * @param {string} id
 * @returns {Promise<object|undefined>}
 */
export async function loadProfile(storeDir, id) {
  const { readFile } = await import('node:fs/promises')
  try {
    const text = await readFile(join(storeDir, `${String(id)}.json`), 'utf8')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 列出已保存的档案（只返回非敏感字段）。
 *
 * @param {string} storeDir
 * @returns {Promise<object[]>}
 */
export async function listProfiles(storeDir) {
  const { readdir, readFile } = await import('node:fs/promises')
  let names
  try {
    names = await readdir(storeDir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await readFile(join(storeDir, name), 'utf8'))
      // 双保险：即使文件被手工改过，也不把敏感字段回给调用方
      out.push(persistableProfile(parsed))
    } catch {
      // 坏文件跳过，不让一个坏档案挡住整个列表
    }
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

/**
 * 删除一个已保存的档案。
 *
 * @param {string} storeDir
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteProfile(storeDir, id) {
  const { unlink } = await import('node:fs/promises')
  try {
    await unlink(join(storeDir, `${String(id)}.json`))
    return true
  } catch {
    return false
  }
}
