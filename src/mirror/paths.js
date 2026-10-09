/**
 * 远程 POSIX 路径 ↔ 锚点本地路径的映射，以及锚点内的路径围栏。
 *
 * 两条硬约束来自项目约定：
 *   1. 围栏判定必须发生在 **`realpath` 之后** —— 否则一个指向锚点外的符号链接就能让镜像
 *      写入逃逸出去（防符号链接逃逸）。这里的 `assertInsideAnchor()` 就是这个判定，
 *      它**只接受已解析的真实路径**，调用方必须先把 `realpath` 的结果递进来。
 *   2. 拒绝时用 `FS_SANDBOX_DENIED` —— 与宿主同一套错误码，调用方按码分支，不解析文案。
 *
 * 为什么需要围栏：远程目录里可能存在指向 `/etc` 的符号链接，或者恶意构造的文件名。
 * 镜像层是「远程内容 → 本地磁盘」的唯一写入通道，一旦逃逸就是本地任意文件写。
 */
import { posix, win32 } from 'node:path'

/** 目标环境是 POSIX（见项目范围），远程路径一律按 POSIX 规则处理。 */
export const REMOTE_SEPARATOR = '/'

/** 拒绝越界写入时使用的错误码，与宿主一致。 */
export const FS_SANDBOX_DENIED = 'FS_SANDBOX_DENIED'

/** 路径围栏拒绝。`code` 恒为 `FS_SANDBOX_DENIED`。 */
export class FenceError extends Error {
  /**
   * @param {string} message
   * @param {{ remotePath?: string, anchorPath?: string, reason?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'FenceError'
    this.code = FS_SANDBOX_DENIED
    this.remotePath = details.remotePath ?? ''
    this.anchorPath = details.anchorPath ?? ''
    this.reason = details.reason ?? ''
  }
}

/**
 * 把远程绝对路径归一化成一个**相对远程根**的 POSIX 相对路径。
 *
 * 归一化会吃掉 `.` 与 `..` 段；任何试图逃出远程根的输入都会被围栏拒绝。
 *
 * @param {string} remotePath 远程侧路径（绝对或相对 remoteRoot）
 * @param {string} remoteRoot 远程根，例如 `/data/project`
 * @returns {string} 形如 `src/app.js` 的相对路径；远程根本身返回 `''`
 * @throws {FenceError} 路径逃出 remoteRoot 时
 */
export function toRelativeRemotePath(remotePath, remoteRoot) {
  const raw = String(remotePath ?? '')
  if (raw.includes('\0')) {
    throw new FenceError('远程路径含 NUL 字节', { remotePath: raw, reason: 'nul-byte' })
  }

  const root = normalizeRemoteRoot(remoteRoot)
  const absolute = raw === '' ? root : posix.resolve(root, raw)
  const normalized = posix.normalize(absolute)

  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new FenceError(`远程路径逃出了远程根：${raw}`, {
      remotePath: raw,
      reason: 'escapes-remote-root',
    })
  }
  return normalized === root ? '' : normalized.slice(root.length + 1)
}

/** 归一化远程根：必须以 `/` 开头，去掉尾部斜杠（`/` 自身除外）。 */
export function normalizeRemoteRoot(remoteRoot) {
  const raw = String(remoteRoot ?? '').trim()
  if (raw === '') {
    throw new FenceError('远程根不能为空', { reason: 'empty-remote-root' })
  }
  if (!raw.startsWith('/')) {
    throw new FenceError(`远程根必须是绝对 POSIX 路径：${raw}`, {
      remotePath: raw,
      reason: 'remote-root-not-absolute',
    })
  }
  if (raw.includes('\0')) {
    throw new FenceError('远程根含 NUL 字节', { remotePath: raw, reason: 'nul-byte' })
  }
  const normalized = posix.normalize(raw)
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

/**
 * 把「相对远程根的路径」映射到锚点内的本地绝对路径。
 *
 * **这里不做围栏判定** —— 它只是字符串拼接，判定必须在 `realpath` 之后做，
 * 见 `assertInsideAnchor()`。之所以拆开，是因为围栏只有在路径真的落到磁盘上、
 * 符号链接被解析之后才有意义。
 *
 * @param {string} anchorPath 锚点目录（本地绝对路径）
 * @param {string} relativeRemotePath 相对远程根的 POSIX 相对路径（`''` 表示根本身）
 * @returns {string} 本地绝对路径
 */
export function toAnchorPath(anchorPath, relativeRemotePath) {
  const relative = normalizeRelative(relativeRemotePath)
  const anchor = String(anchorPath ?? '')
  if (anchor === '') {
    throw new FenceError('锚点目录不能为空', { reason: 'empty-anchor' })
  }
  if (relative === '') return anchor
  // 逐段拼接：不能把整串交给 join，否则 `a/b` 在 Windows 上不会被拆开。
  // 注意 `win32.isAbsolute('/tmp/anchor')` 在 Windows 上也是 true，
  // 所以必须**同时**要求盘符或 UNC 前缀，否则 POSIX 锚点会被拼成反斜杠路径。
  const segments = relative.split(REMOTE_SEPARATOR)
  return isWindowsPath(anchor) ? win32.join(anchor, ...segments) : posix.join(anchor, ...segments)
}

/** 是否是 Windows 风格路径（盘符或 UNC），而不是「Windows 上也算绝对的」POSIX 路径。 */
function isWindowsPath(candidate) {
  return /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\')
}

/**
 * 把锚点内的本地路径反解成远程绝对路径（手动刷新 / 诊断用）。
 *
 * @param {string} anchorPath
 * @param {string} remoteRoot
 * @param {string} anchorFilePath 锚点内的本地绝对路径
 * @returns {string} 远程绝对路径
 */
export function toRemotePath(anchorPath, remoteRoot, anchorFilePath) {
  const root = normalizeRemoteRoot(remoteRoot)
  const relative = relativeFromAnchor(anchorPath, anchorFilePath)
  return relative === '' ? root : posix.join(root, relative)
}

/**
 * 求某个本地路径相对锚点的 POSIX 相对路径。
 * @param {string} anchorPath
 * @param {string} localPath
 * @returns {string}
 */
export function relativeFromAnchor(anchorPath, localPath) {
  const anchorRaw = String(anchorPath)
  const targetRaw = String(localPath)
  // 统一用 isWindowsPath 判断风格：`win32.isAbsolute('/tmp/x')` 在 Windows 上是 true，
  // 用它会把 POSIX 路径当成 Windows 路径处理。
  const useWin32 = isWindowsPath(anchorRaw) || isWindowsPath(targetRaw)
  const anchor = useWin32 ? win32.normalize(anchorRaw) : posix.normalize(anchorRaw)
  const target = useWin32 ? win32.normalize(targetRaw) : posix.normalize(targetRaw)
  const rel = useWin32 ? win32.relative(anchor, target) : posix.relative(anchor, target)
  return normalizeRelative(useWin32 ? rel.replace(/\\/g, '/') : rel)
}

/**
 * 归一化一个「相对远程根的路径」。
 * @param {string} input
 * @returns {string}
 */
export function normalizeRelative(input) {
  const raw = String(input ?? '').replace(/\\/g, '/')
  if (raw.includes('\0')) {
    throw new FenceError('相对路径含 NUL 字节', { remotePath: raw, reason: 'nul-byte' })
  }
  const stripped = raw.replace(/^\/+/, '').replace(/\/+$/, '')
  if (stripped === '') return ''
  const normalized = posix.normalize(stripped)
  if (normalized === '.' || normalized === '') return ''
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new FenceError(`相对路径逃出了根：${raw}`, { remotePath: raw, reason: 'escapes-root' })
  }
  return normalized
}

/**
 * **围栏判定**：确认一个**已经 realpath 过**的本地路径确实落在锚点内。
 *
 * 关键在「已经 realpath 过」：如果只比较字符串，`<anchor>/link-to-etc/passwd` 会通过；
 * 解析之后它变成 `/etc/passwd`，才会被这里拒绝。
 *
 * @param {string} resolvedAnchorPath 锚点目录的 realpath
 * @param {string} resolvedTargetPath 目标路径的 realpath
 * @param {{ remotePath?: string }} [context] 仅用于报错信息
 * @returns {string} 通过时原样返回 `resolvedTargetPath`
 * @throws {FenceError}
 */
export function assertInsideAnchor(resolvedAnchorPath, resolvedTargetPath, context = {}) {
  const anchor = normalizeForCompare(String(resolvedAnchorPath ?? ''))
  const target = normalizeForCompare(String(resolvedTargetPath ?? ''))
  if (anchor === '' || target === '') {
    throw new FenceError('围栏判定需要两个非空路径', {
      remotePath: context.remotePath,
      anchorPath: anchor,
      reason: 'empty-path',
    })
  }

  const useWin32 = isWindowsPath(anchor)
  const rel = useWin32 ? win32.relative(anchor, target) : posix.relative(anchor, target)
  const escaped =
    rel === '..' ||
    rel.startsWith(`..${useWin32 ? '\\' : '/'}`) ||
    (useWin32 ? win32.isAbsolute(rel) : posix.isAbsolute(rel))

  if (escaped) {
    throw new FenceError(`路径逃出了锚点目录：${target}`, {
      remotePath: context.remotePath,
      anchorPath: anchor,
      reason: 'escapes-anchor',
    })
  }
  return resolvedTargetPath
}

/** 比较用的归一化：Windows 上大小写不敏感 + 反斜杠；POSIX 上原样。 */
function normalizeForCompare(input) {
  if (input === '') return ''
  if (isWindowsPath(input)) {
    // Windows 路径大小写不敏感：`<盘符>:\Anchor` 与 `<盘符>:\anchor\x` 必须被判为同源，
    // 否则 `win32.relative()` 会算出 `..\..` 这种假逃逸（或反过来漏判）。
    const trimmed = win32.normalize(input).toLowerCase()
    return trimmed.length > 3 && trimmed.endsWith('\\') ? trimmed.slice(0, -1) : trimmed
  }
  const trimmed = posix.normalize(input)
  return trimmed.length > 1 && trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}
