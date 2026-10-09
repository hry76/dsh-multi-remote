/**
 * 界面（客户端半边）用的 HTTP 路由辅助。
 *
 * ## 为什么客户端走 HTTP，而不是 `host.call`
 *
 * 客户端内置的 `host.call` 是「包私有 RPC」，但宿主侧怎么注册它没有公开约定。
 * 实测已安装的第三方客户端插件（`dsh-better-sidebar`）的做法是
 * **`fetch('/<插件前缀>/api/<方法>')`** —— 也就是走 HTTP 路由。
 *
 * 我们本来就有这条路：`ctx.webServer.register()` + `src/http/fence.js` 的同源校验。
 * 复用它最省事，也不会引入一个我不知道契约的接缝。
 *
 * ## 这一层的职责
 *
 * 把「界面发来的 JSON」变成「规范化后的连接请求」——
 * **严格白名单**，不认识的字段直接丢掉，绝不整包往下传。
 * 界面是浏览器里的代码，不能假定它只会发好东西。
 *
 * 凭据例外：`password` / `privateKey` / `passphrase` 属于「敏感字段」，
 * 允许传（SSH 场景绕不开），但**任何响应里都不回显**，也不写进审计。
 */

/** 界面读「有哪些可选项」的路由。 */
export const ROUTE_UI_OPTIONS = '/multi-remote/connect-options'

/** 界面请求「打开系统选文件夹窗口」的路由。 */
export const ROUTE_UI_PICK = '/multi-remote/pick-directory'

/** 界面发起「连接一个远程工作区」的路由。 */
export const ROUTE_UI_CONNECT = '/multi-remote/connect'

/**
 * 「先连机器、再选文件夹」流程的三条路由（2026-10-07 用户提出）。
 *
 * 为什么值得单开一条流程：原来的「一次填完」要求用户**盲填远程项目根**，
 * 填错了连接照样成功、之后每条命令都切不到目录（真机事故）。
 * 改成先连机器 → 再**看着远程真实目录点选** → 路径不再靠猜。
 */
export const ROUTE_UI_MACHINE_CONNECT = '/multi-remote/machine-connect'
export const ROUTE_UI_MACHINE_LIST = '/multi-remote/machine-list'
export const ROUTE_UI_MACHINE_OPEN = '/multi-remote/machine-open'
export const ROUTE_UI_MACHINE_DISCONNECT = '/multi-remote/machine-disconnect'

/**
 * 打开任务：`machine-open` 现在**任务化**了 —— POST 启动任务立即返回 `taskId`，
 * 前端轮询本端点拿「走到哪一步」的实时进度，点取消则调用 `open-cancel`。
 * 这样大项目打开时界面不再是一个黑盒的「正在连接…」转圈。
 */
export const ROUTE_UI_OPEN_PROGRESS = '/multi-remote/open-progress'
export const ROUTE_UI_OPEN_CANCEL = '/multi-remote/open-cancel'

/**
 * 把锚点目录**建成工作区并起个像样的名字**。
 *
 * 为什么放在宿主侧做：客户端那边要先 `ctx.get('workspaces')` 拿到服务再创建，
 * 实测**拿不到**（自动创建失败，退化成了「请手工打开这个目录」的提示 ——
 * 用户看到的正是那句提示）。宿主侧本来就能访问 `workspaceRegistry`，
 * 而且 `create(path, title)` **支持标题** —— 正好满足
 * 「工作区应该显示 `ssh:/data/my-proj/my-proj` 而不是 mr-ssh-home-user-…」。
 */
export const ROUTE_UI_OPEN_WORKSPACE = '/multi-remote/open-workspace'

/**
 * 给工作区起名：`<后端>:<最后一层目录>`，例如 `ssh:my-proj`、`wsl:test-proj`。
 *
 * 演进过程（用户的三次反馈，每次都更准）：
 *   1. `mr-ssh-home-user-my-proj-afea9e990734`   内部标识，看不懂
 *   2. `ssh:/data/my-proj/my-proj`             能看懂，但**太长**，侧边栏放不下
 *   3. `my-proj`                               短了，但**看不出是哪台机器**
 *   4. `ssh:my-proj`                           ← 现在：短 + 带后端标识
 *
 * 为什么保留后端前缀：同名文件夹很常见（两台机器上都有 `project`），
 * 只显示文件夹名的话侧边栏会出现两个一模一样的条目。
 * 完整路径仍然不挤进名字里 —— 选目录那一步的弹窗里已经显示过了。
 *
 * @param {string} kind 后端类型：ssh / wsl / docker
 * @param {string} remoteRoot
 * @returns {string}
 */
export function workspaceTitle(kind, remoteRoot) {
  const backend = typeof kind === 'string' && kind !== '' ? kind : 'remote'
  const root = String(remoteRoot ?? '').replace(/\/+$/, '')
  const base = root.split('/').filter((part) => part !== '').pop()
  if (base === undefined || base === '') {
    // 根目录（`/`）或空路径：总不能显示成 `ssh:` 这种半截名字
    return backend
  }
  return `${backend}:${base}`.slice(0, 120)
}

/**
 * 客户端半边的**自诊断上报**路由。
 *
 * 为什么需要它：客户端代码跑在浏览器里，出问题时**我们看不到它的控制台**。
 * 于是「点 `+` 没反应」这种问题只能靠猜 —— 实测就吃过一次亏：
 * 注册写在了 `fetch(...).then(...)` 里，异步回调不在插件的生效作用域内，
 * 注册静默失效，而界面表现只是「还是官方行为」，完全看不出原因。
 *
 * 有了这条路由，客户端可以把「走到哪一步、成没成、报什么错」直接报回宿主，
 * 我们从审计日志就能读出来。
 */
export const ROUTE_UI_CLIENT_REPORT = '/multi-remote/client-report'

/**
 * 插件设置：读当前配置 / 改配置。
 *
 * 改配置**不自己写文件** —— 走宿主的 `configEditor` 服务：它负责
 * **校验、持久化，并走正常 Loader 路径重新应用**（也就是说改完插件会重载）。
 * 我们只负责把「界面想改什么」规范化成一份补丁。
 */
export const ROUTE_UI_SETTINGS = '/multi-remote/settings'

/** 设置项的取值范围（与 README 里写的默认值保持一致）。 */
export const SETTINGS_LIMITS = {
  maxFileBytesMiB: { min: 0, max: 512 },
  maxTotalBytesMiB: { min: 0, max: 4096 },
  auditCapacity: { min: 10, max: 100_000 },
}

/** 整数 + 范围校验（不合法就**明确报错**，不静默改成默认值）。 */
function intInRange(value, label, range) {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${label} 必须是整数`)
  if (value < range.min || value > range.max) throw new Error(`${label} 必须在 ${range.min}–${range.max} 之间`)
  return value
}

/**
 * 规范化「改设置」的请求体。
 *
 * **只认白名单里的字段**，逐项做类型与范围校验 —— 界面传什么都不能直接进配置。
 * 非法值一律**明确报错**，绝不静默丢弃（静默丢弃会让用户以为「保存成功了」）。
 *
 * @param {unknown} raw
 * @returns {object} 可直接合并进配置的补丁
 * @throws {Error} 有非法值 / 没有任何可改项时
 */
export function normalizeSettingsPatch(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('设置必须是一个对象')
  }
  const patch = {}

  if (raw.auditCapacity !== undefined) {
    patch.auditCapacity = intInRange(raw.auditCapacity, 'auditCapacity', SETTINGS_LIMITS.auditCapacity)
  }

  if (raw.mirrorDeepen !== undefined) {
    const deep = raw.mirrorDeepen
    if (typeof deep !== 'object' || deep === null || Array.isArray(deep)) {
      throw new Error('mirrorDeepen 必须是一个对象')
    }
    const out = {}
    if (deep.enabled !== undefined) {
      if (typeof deep.enabled !== 'boolean') throw new Error('mirrorDeepen.enabled 必须是布尔值')
      out.enabled = deep.enabled
    }
    // 界面用 MiB 输入（字节对用户不友好）；**存进配置的还是字节**
    if (deep.maxFileBytesMiB !== undefined) {
      out.maxFileBytes = intInRange(deep.maxFileBytesMiB, 'mirrorDeepen.maxFileBytesMiB', SETTINGS_LIMITS.maxFileBytesMiB) * 1024 * 1024
    }
    if (deep.maxTotalBytesMiB !== undefined) {
      out.maxTotalBytes = intInRange(deep.maxTotalBytesMiB, 'mirrorDeepen.maxTotalBytesMiB', SETTINGS_LIMITS.maxTotalBytesMiB) * 1024 * 1024
    }
    patch.mirrorDeepen = out
  }

  if (Object.keys(patch).length === 0) throw new Error('没有任何可改的设置项')
  return patch
}

/** 自诊断上报的单步文本上限。 */
const MAX_REPORT_DETAIL = 300

/**
 * 规范化客户端上报。
 *
 * 这是**诊断数据**，不是业务请求 —— 所以不抛错：能收多少收多少。
 * 上报本身绝不该让界面出问题。
 *
 * @param {unknown} raw
 * @returns {{ step: string, ok: boolean, detail: string | null }}
 */
export function normalizeClientReport(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const step = typeof source.step === 'string' && source.step !== '' ? source.step.slice(0, 80) : '(未命名步骤)'
  const detail = source.detail === undefined || source.detail === null
    ? null
    : String(source.detail).slice(0, MAX_REPORT_DETAIL)
  return { step, ok: source.ok === true, detail }
}

/** POST body 的上限（字节）。连接请求就是几个短字段，64 KiB 绰绰有余。 */
export const MAX_BODY_BYTES = 64 * 1024

/** 允许从界面传进来的字段（白名单）。其余一律丢弃。 */
const ALLOWED_FIELDS = [
  'id',
  'kind',
  'remoteRoot',
  'anchorParent',
  'distro',
  'wslUser',
  'container',
  'host',
  'port',
  'username',
  'privateKeyPath',
  'password',
  'passphrase',
]

/**
 * 敏感字段：可以传进来，但**绝不回显、不进审计**。
 *
 * ⚠️ **刻意不含 `privateKeyPath`** —— 那是**路径**，不是凭据（凭据是私钥**内容**
 * 与口令；路径本身认证不了任何人，而且 profile.js 本来就把它落盘）。
 * 界面正是靠它把「用过的连接」填满，否则用户每次都要重敲一遍
 * `~/.ssh/id_ed25519`（实测反馈）。私钥**内容**与口令这三样永不回显 ——
 * 见 `describeProfiles` 的白名单，它只挑字段，不 spread。
 */
export const SENSITIVE_FIELDS = ['password', 'passphrase', 'privateKey']

/** 三种后端的必填字段。缺了就报清楚，不猜。 */
const REQUIRED_BY_KIND = {
  ssh: ['host', 'username'],
  wsl: ['distro'],
  docker: ['container'],
}

/**
 * 从「后端 + 远程根」推导一个默认的连接档案 id。
 *
 * **为什么要自动生成**：`remote_connect` 工具要求用户显式给 id，
 * 但界面用户不该被要求起名 —— 点「连接」就要能连上。
 * （2026-10-07 实测：界面没发 id，宿主报「id 必填」，连接被拒。）
 *
 * 规则：小写、只留 `[a-z0-9-]`（**绝不能含点号** —— id 会进预设 id，
 * 含点号会让插件树加载失败，实测踩过）、截断到 60 字符。
 *
 * @param {string} kind
 * @param {string} remoteRoot
 * @returns {string}
 */
export function deriveConnectId(kind, remoteRoot) {
  const slug = String(remoteRoot ?? '')
    .toLowerCase()
    .split('/')
    .filter((part) => part !== '')
    .join('-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = slug === '' ? String(kind ?? 'remote') : `${kind}-${slug}`
  return base.slice(0, 60).replace(/-+$/g, '')
}

/**
 * 读并解析 POST body（JSON）。
 *
 * 超限、非法 JSON、空 body 都要给出**能看懂**的原因 ——
 * 界面会把它直接显示给用户，所以别只说「bad request」。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limitBytes]
 * @returns {Promise<unknown>}
 */
export function readJsonBody(req, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error(`请求体超过 ${limitBytes} 字节上限`))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法的 JSON'))
      }
    })
    req.on('error', (error) => reject(error))
  })
}

/**
 * 校验并规范化界面发来的连接请求。
 *
 * **严格白名单 + 按后端校验必填**：任何不认识的字段直接丢掉，
 * 缺必填字段抛出带原因的错误（界面直接显示给用户）。
 *
 * @param {unknown} raw
 * @returns {Record<string, unknown>} 可以交给 `connections.connect()` 的对象
 */
export function normalizeConnectRequest(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('连接请求必须是一个 JSON 对象')
  }

  const input = {}
  for (const key of ALLOWED_FIELDS) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed !== '') input[key] = trimmed
      continue
    }
    if (key === 'port' && typeof value === 'number' && Number.isFinite(value)) {
      input.port = value
    }
  }

  const kind = typeof input.kind === 'string' ? input.kind : 'ssh'
  if (!Object.hasOwn(REQUIRED_BY_KIND, kind)) {
    throw new Error(`不支持的后端类型：${kind}（可选：ssh / wsl / docker）`)
  }
  input.kind = kind

  if (typeof input.remoteRoot !== 'string' || !input.remoteRoot.startsWith('/')) {
    throw new Error('远程项目根必须是绝对 POSIX 路径（以 / 开头）')
  }

  for (const field of REQUIRED_BY_KIND[kind]) {
    if (typeof input[field] !== 'string' || input[field] === '') {
      throw new Error(`后端 ${kind} 缺少必填字段：${field}`)
    }
  }

  if (input.port !== undefined) {
    const port = Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`端口必须是 1–65535 的整数，收到：${String(input.port)}`)
    }
    input.port = port
  }

  return input
}

/**
 * 从「已保存的连接档案」里挑出界面要显示的字段。
 *
 * **刻意不返回凭据**：档案里的密码 / 私钥**内容**永不回显 ——
 * 回显出去只会让用户以为「它记得」。
 *
 * ⚠️ 但**私钥路径要返回**：它是路径不是凭据，而界面正是靠它把「用过的连接」
 * 填满 —— 不返回的话用户还得把 `~/.ssh/id_ed25519` 重敲一遍（那正是要消灭的）。
 *
 * @param {Array<object>} profiles
 */
export function describeProfiles(profiles) {
  return (Array.isArray(profiles) ? profiles : []).map((profile) => ({
    id: profile?.id ?? null,
    kind: profile?.kind ?? null,
    label: profile?.label ?? null,
    remoteRoot: profile?.remoteRoot ?? null,
    distro: profile?.distro ?? null,
    container: profile?.container ?? null,
    host: profile?.host ?? null,
    port: profile?.port ?? null,
    username: profile?.username ?? null,
    privateKeyPath: profile?.privateKeyPath ?? null,
    /** 机器级档案（只记机器，没有项目根）—— 界面用它填「用过的连接」。 */
    machine: profile?.machine === true,
  }))
}

/** 给界面看的成功结果（**不含凭据**）。 */
export function describeConnected(described) {
  const target = described.kind === 'wsl'
    ? `WSL ${described.distro}`
    : described.kind === 'docker'
      ? `容器 ${described.container}`
      : `${described.username}@${described.host}:${described.port}`
  return {
    profileId: described.id,
    kind: described.kind,
    label: described.label,
    target,
    remoteRoot: described.remoteRoot,
    anchorPath: described.anchorPath,
    presetId: described.presetId,
  }
}
