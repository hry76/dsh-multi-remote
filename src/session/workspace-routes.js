/**
 * 工作区路由表 —— 把「远程路径 / 锚点路径」路由到对应的工作区上下文。
 *
 * ## 为什么需要（方案 A：单一远程模式 + 按路径路由）
 *
 * DSH 的预设是**全局的**（模式选择器列的是 `agentPresets.list()`，definition
 * 没有 scope/workspace 字段 —— 见宿主 `dsh-agent-preset-registry`）。所以
 * 每打开一个远程项目就注册一个预设，模式列表就会出现 N 个「远程模式」，
 * 而且每个会话都能切到**别人**的预设（写错项目）。
 *
 * 解法：**预设收敛成一个**「远程模式」，域内 provider **不绑固定连接**，
 * 每次操作按「路径」路由到正确的连接：
 *
 *   - 远程绝对路径 → 按 remoteRoot 最长前缀匹配
 *   - 锚点路径（会话 cwd 是锚点）→ 按 anchorPath 最长前缀匹配
 *
 * 路由表本身是**模块级只读查询**（与 transport 注册表同一存在理由）：
 * 隔离域里的 provider 只能按路径查，不能改。
 *
 * 拿不到路由就**明确报错**，绝不回退到本机 —— 这是本项目的硬约束。
 */
import { requireTransport, lookupMirror } from '../transport/registry.js'
import posix from 'node:path/posix'

/** @type {Map<string, { remoteRoot: string, anchorPath: string|undefined }>} */
const routes = new Map()

/**
 * 注册一条工作区路由。
 * @param {string} profileId
 * @param {{ remoteRoot: string, anchorPath?: string }} options
 */
export function registerWorkspaceRoute(profileId, options) {
  const key = String(profileId ?? '').trim()
  if (key === '') throw new Error('registerWorkspaceRoute 需要非空的 profileId')
  const remoteRoot = String(options?.remoteRoot ?? '').trim()
  if (!remoteRoot.startsWith('/')) throw new Error('registerWorkspaceRoute 需要绝对 POSIX remoteRoot')
  if (routes.has(key)) {
    throw new Error(`连接档案 ${key} 已经注册过工作区路由（重复路由会让操作发往错误的机器）`)
  }
  routes.set(key, {
    remoteRoot,
    anchorPath: typeof options?.anchorPath === 'string' ? options.anchorPath : undefined,
  })
}

/** 注销一条工作区路由。 */
export function unregisterWorkspaceRoute(profileId) {
  return routes.delete(String(profileId ?? '').trim())
}

/** 清空路由表（测试与插件卸载用）。 */
export function clearWorkspaceRoutes() {
  const count = routes.size
  routes.clear()
  return count
}

/** POSIX 路径归一（去尾斜杠）。 */
function normPosix(value) {
  return String(value ?? '').replace(/\/+$/, '')
}

/** 本地路径归一（反斜杠转正斜杠、去尾斜杠、win 大小写不敏感）。 */
function normLocal(value) {
  const s = String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * 由 profileId 组装工作区上下文（含活的 transport / mirror）。
 * 拿不到 transport（连接已断）返回 undefined —— 调用方据报错。
 */
function contextFor(profileId) {
  let transport
  try {
    transport = requireTransport(profileId)
  } catch {
    return undefined
  }
  return {
    profileId,
    remoteRoot: routes.get(profileId).remoteRoot,
    anchorPath: routes.get(profileId).anchorPath,
    transport,
    mirror: lookupMirror(profileId),
  }
}

/**
 * 按**远程绝对路径**路由（remoteRoot 最长前缀匹配）。
 *
 * @param {string} remotePath
 * @returns {{ profileId: string, remoteRoot: string, anchorPath: string|undefined,
 *             transport: object, mirror: object|undefined } | undefined}
 */
export function routeByRemotePath(remotePath) {
  const target = normPosix(remotePath)
  if (target === '' || !target.startsWith('/')) return undefined

  let best = null
  let bestLen = -1
  for (const profileId of routes.keys()) {
    const root = normPosix(routes.get(profileId).remoteRoot)
    if (target === root || target.startsWith(`${root}/`)) {
      if (root.length > bestLen) {
        best = profileId
        bestLen = root.length
      }
    }
  }
  if (best === null) return undefined
  return contextFor(best)
}

/**
 * 按**锚点路径**路由（anchorPath 最长前缀匹配）。
 *
 * @param {string} localPath 本机锚点形态的路径（会话 cwd 就是它）
 * @returns {object|undefined} 同 {@link routeByRemotePath}
 */
export function routeByAnchorPath(localPath) {
  const target = normLocal(localPath)
  if (target === '') return undefined

  let best = null
  let bestLen = -1
  for (const profileId of routes.keys()) {
    const anchor = normLocal(routes.get(profileId).anchorPath ?? '')
    if (anchor === '') continue
    if (target === anchor || target.startsWith(`${anchor}/`)) {
      if (anchor.length > bestLen) {
        best = profileId
        bestLen = anchor.length
      }
    }
  }
  if (best === null) return undefined
  return contextFor(best)
}

/**
 * 把「远程路径 + 它所属工作区」的 remoteRoot 换算成**相对项目根**的 POSIX 路径。
 * @param {object} ctx 路由结果（{@link routeByRemotePath} 的返回值）
 * @param {string} remotePath
 * @returns {string|undefined} 不在 remoteRoot 内返回 undefined
 */
export function relativeToRoot(ctx, remotePath) {
  const root = normPosix(ctx.remoteRoot)
  const target = normPosix(remotePath)
  if (target === root) return undefined // 根自身不是文件
  if (!target.startsWith(`${root}/`)) return undefined
  return target.slice(root.length + 1)
}

/**
 * 把「工具给的路径 + 会话 cwd」翻译成**远程绝对路径**，并路由到所属工作区。
 *
 * 翻译规则（与旧的 `world/translate.js` 对齐，但「远程根」来自路由而非固定值）：
 *   1. 已是远程绝对 POSIX 路径 → 归一化，按 remoteRoot 路由（不命中就报错）
 *   2. 锚点形态（路径在某个锚点之下）→ 路由到那个工作区，翻译成远程路径
 *   3. 相对路径 → 用会话 cwd（锚点）路由，拼到那个工作区的 remoteRoot 下
 *   4. cwd 本身是远程绝对路径 → 用它路由
 *   5. 都不行 → **报错**（不再「回退远程根」—— 现在没有唯一远程根了）
 *
 * @param {string} path 工具给的路径（绝对或相对）
 * @param {{ cwd?: string }} [options]
 * @returns {{ remotePath: string, ctx: object }}
 * @throws {Error} 路径不属于任何已连接项目时抛出
 */
export function translateToRemote(path, options = {}) {
  const raw = String(path ?? '').trim()
  const cwd = options.cwd

  // 1) 远程绝对路径
  if (raw.startsWith('/')) {
    const remote = posix.normalize(raw)
    const ctx = routeByRemotePath(remote)
    if (ctx === undefined) {
      throw new Error(
        `路径 "${remote}" 不属于任何已连接的远程项目（请先打开对应项目，或使用项目内的路径）`,
      )
    }
    return { remotePath: remote, ctx }
  }

  // 2) 锚点形态（路径本身落在某个锚点之下）
  const byAnchor = routeByAnchorPath(raw)
  if (byAnchor !== undefined) {
    const rel = anchorRelativePart(byAnchor.anchorPath, raw)
    return {
      remotePath: posix.normalize(posix.join(byAnchor.remoteRoot, rel)),
      ctx: byAnchor,
    }
  }

  // 3) 相对路径 → 用 cwd（锚点）路由
  const byCwd = routeByAnchorPath(cwd)
  if (byCwd !== undefined) {
    return {
      remotePath: posix.normalize(posix.join(byCwd.remoteRoot, raw)),
      ctx: byCwd,
    }
  }

  // 4) cwd 本身是远程绝对路径
  if (typeof cwd === 'string' && cwd.startsWith('/')) {
    const byCwdRemote = routeByRemotePath(posix.normalize(cwd))
    if (byCwdRemote !== undefined) {
      return {
        remotePath: posix.normalize(posix.join(byCwdRemote.remoteRoot, raw)),
        ctx: byCwdRemote,
      }
    }
  }

  throw new Error(
    `无法确定路径 "${raw}" 属于哪个远程项目（当前没有已连接的远程项目，或 cwd 不是锚点目录）`,
  )
}

/** 算「本地路径」相对「锚点目录」的部分（去尾斜杠、win 大小写不敏感已在路由层处理）。 */
function anchorRelativePart(anchorPath, localPath) {
  const a = normLocal(anchorPath)
  const t = normLocal(localPath)
  if (t === a) return ''
  return String(localPath).replace(/\\/g, '/').replace(/\/+$/, '').slice(a.length + 1)
}
