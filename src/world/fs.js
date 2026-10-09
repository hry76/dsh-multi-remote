/**
 * 隔离域内的 `fs` provider —— 把每一次文件操作转发到远程。
 *
 * 这个模块**只在预设的隔离域里挂载**（见 `src/session/preset.js`）。
 * 全局 `ctx.fs` 保持宿主实现不动，所以本地会话完全不受影响。
 *
 * ## 为什么这里是「正确性」的关键
 *
 * 它换掉的是 agent 的**手脚**：agent 的 read / write / edit / glob / grep 全部经 `ctx.fs`。
 * 一旦这里静默回退到本机，用户会在界面上看到「已连上远程」，而文件其实读写在本机 ——
 * 这是本项目最坏的失败模式。所以：
 *
 *   - 拿不到路由（路径不属于任何已连接项目）就**抛错**，绝不回退（`routeFor` 保证）。
 *   - 契约里没实现的方法**抛错**，不返回 undefined 让上层猜。
 *
 * ## 契约（来自宿主 `dsh-fs` 与 `dsh-fs-local` 的公开方法）
 *
 *   resolve(path, {cwd, signal}) → { targetKey, displayPath }
 *   stat(target, signal)         → { version, type, size } | undefined
 *   lstat(path, {cwd}, signal)   → { version, type, size } | undefined
 *   readText(target, signal)     → string
 *   listDir(target, signal)      → [{ name, type, target, version?, size? }]
 *   writeText(target, content, expected, signal) → { operation, version, before, after }
 *   editText(target, edit, expected, signal)     → { version, before, after }
 *   readBytes / readByteRange / streamText / watch / contains / fileUrl / processPath
 */
import { posix } from 'node:path'

import { routeByRemotePath, translateToRemote, relativeToRoot } from '../session/workspace-routes.js'
import { TRANSPORT_ERROR } from '../transport/transport.js'

/** 宿主 `FsError` 的错误码子集（我们只产出这几个）。 */
export const FS_ERROR = {
  NOT_FOUND: 'FS_NOT_FOUND',
  NOT_DIRECTORY: 'FS_NOT_DIRECTORY',
  NOT_REGULAR_FILE: 'FS_NOT_REGULAR_FILE',
  NOT_TEXT: 'FS_NOT_TEXT',
  TOO_LARGE: 'FS_TOO_LARGE',
  PERMISSION_DENIED: 'FS_PERMISSION_DENIED',
  STALE_VERSION: 'FS_STALE_VERSION',
  NOT_OBSERVED: 'FS_NOT_OBSERVED',
  AMBIGUOUS_EDIT: 'FS_AMBIGUOUS_EDIT',
  ABORTED: 'FS_ABORTED',
  IO_ERROR: 'FS_IO_ERROR',
}

/**
 * 与宿主 `FsError` 同形：带 `code` 的 Error。
 * 调用方按 `code` 分支，**绝不解析 message 文案**。
 */
export class WorldFsError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{ cause?: unknown, displayPath?: string }} [details]
   */
  constructor(message, code, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'FsError'
    this.code = code
    this.displayPath = details.displayPath ?? ''
  }
}

/** 把 transport 的错误码映射成宿主 fs 的错误码。 */
function mapTransportError(error, displayPath, verb) {
  // 已经是 WorldFsError（如「路径不属于任何已连接项目」）→ 原样透传，不再包装
  if (error instanceof WorldFsError) return error
  const code = error?.code
  const detail = error?.message ?? String(error)
  const at = displayPath === '' ? '' : ` "${displayPath}"`
  switch (code) {
    case TRANSPORT_ERROR.NOT_FOUND:
      return new WorldFsError(`cannot ${verb}${at}: not found`, FS_ERROR.NOT_FOUND, { cause: error, displayPath })
    case TRANSPORT_ERROR.PERMISSION_DENIED:
      return new WorldFsError(`cannot ${verb}${at}: permission denied`, FS_ERROR.PERMISSION_DENIED, { cause: error, displayPath })
    case TRANSPORT_ERROR.NOT_TEXT:
      return new WorldFsError(`cannot ${verb}${at}: not valid UTF-8 text`, FS_ERROR.NOT_TEXT, { cause: error, displayPath })
    case TRANSPORT_ERROR.TOO_LARGE:
      return new WorldFsError(`cannot ${verb}${at}: ${detail}`, FS_ERROR.TOO_LARGE, { cause: error, displayPath })
    case TRANSPORT_ERROR.WRONG_TYPE:
      return new WorldFsError(`cannot ${verb}${at}: wrong file type`, FS_ERROR.NOT_REGULAR_FILE, { cause: error, displayPath })
    case TRANSPORT_ERROR.ABORTED:
      return new WorldFsError(`${verb} aborted`, FS_ERROR.ABORTED, { cause: error, displayPath })
    case TRANSPORT_ERROR.TIMEOUT:
    case TRANSPORT_ERROR.CHANNEL_DEAD:
    case TRANSPORT_ERROR.NOT_CONNECTED:
      // 这三个是「连接层面」的失败，不是「文件层面」的。上层要能区分出来，
      // 否则用户会看到「文件不存在」而实际上是连接断了。
      return new WorldFsError(`cannot ${verb}${at}: ${detail}`, FS_ERROR.IO_ERROR, { cause: error, displayPath })
    default:
      return new WorldFsError(`cannot ${verb}${at}: ${detail}`, FS_ERROR.IO_ERROR, { cause: error, displayPath })
  }
}

/** 从 transport 的 stat 结果算出宿主 fs 的 version。 */
function versionOf(info) {
  const size = typeof info?.size === 'number' ? info.size : -1
  const mtime = typeof info?.mtimeMs === 'number' ? Math.floor(info.mtimeMs / 1000) : -1
  return `${size}:${mtime}`
}

/** transport 的类型 → 宿主 fs 的类型。 */
function typeOf(info) {
  if (info === undefined || info === null) return undefined
  if (info.type === 'directory') return 'directory'
  if (info.type === 'file') return 'file'
  return 'other'
}

export const name = '@jk-uzi/dsh-multi-remote/world-fs'

/**
 * 隔离域里的 fs provider。
 *
 * **方案 A（单一远程模式）**：不再绑定固定的 profileId/remoteRoot —— 每次操作
 * 按「远程路径」路由到对应工作区（`workspace-routes.js`）。一份预设服务所有
 * 远程项目，且路径永远不会错发到另一个项目。
 */
export function apply(ctx, config = {}) {
  const log = ctx.logger

  /**
   * 由远程路径拿到所属工作区的 transport / mirror；拿不到就**报错**（绝不回退本机）。
   */
  const routeFor = (remotePath) => {
    const routed = routeByRemotePath(remotePath)
    if (routed === undefined) {
      throw new WorldFsError(
        `路径 "${remotePath}" 不属于任何已连接的远程项目（请先打开对应项目）`,
        FS_ERROR.NOT_FOUND,
        { displayPath: remotePath },
      )
    }
    return routed
  }

  /**
   * 把任意输入路径解析成远程绝对 POSIX 路径（并路由到所属工作区）。
   *
   * ⚠️ **不能只判断「是不是以 / 开头」**：`tool-fs` 会把**会话 cwd**（= 本机锚点目录）
   * 传下来，模型也自然会用锚点形态的路径。直接拼会得到远程不存在的路径。
   * 翻译 + 路由统一走 `translateToRemote`（见 workspace-routes.js）。
   */
  const toRemoteAbsolute = (path, cwd) => {
    const raw = String(path ?? '')
    if (raw === '') throw new WorldFsError('file_path must be a non-empty string', FS_ERROR.NOT_FOUND)
    try {
      return translateToRemote(raw, { cwd })
    } catch (error) {
      if (error instanceof WorldFsError) throw error
      throw new WorldFsError(error?.message ?? '无法确定远程路径', FS_ERROR.NOT_FOUND, { displayPath: raw })
    }
  }

  /** 构造一个 target：`targetKey` 是远程真实路径，`displayPath` 给模型/界面看。 */
  const makeTarget = (remotePath) => ({ targetKey: remotePath, displayPath: remotePath })

  /**
   * **写后回写**：agent 改了远程文件，顺手把新内容同步进本地镜像 ——
   * 否则界面的文件树和「拉下来的项目」会停留在打开那一刻的快照。
   *
   * 三条边界（每一条都是刻意的）：
   *   - 只回写**项目根之内**的文件（靠路由结果的 relativeToRoot）
   *   - **尽力而为**：回写失败只记日志，绝不影响写操作本身的成败
   *   - 拿不到 mirror → 跳过
   *
   * @param {object} routed 路由结果（含 remoteRoot + mirror）
   * @param {string} remotePath 远程绝对路径
   * @param {string|Buffer} content 刚写进远程的内容（复用，不发额外请求）
   */
  const syncToMirror = (routed, remotePath, content) => {
    const mirror = routed.mirror
    if (mirror === undefined) return
    const relPath = relativeToRoot(routed, remotePath)
    if (relPath === undefined) return
    mirror.photo(relPath, content).then((outcome) => {
      if (outcome.result === 'failed') {
        log?.warn?.('[world-fs] 镜像回写失败（不影响远程写入）：%s — %s', remotePath, outcome.error ?? '')
      }
    }).catch(() => {})
  }

  /** 从 target 里取远程路径。 */
  const pathOf = (target) => {
    const value = typeof target === 'string' ? target : target?.targetKey
    if (typeof value !== 'string' || value === '') {
      throw new WorldFsError('内部错误：target 缺少 targetKey', FS_ERROR.IO_ERROR)
    }
    return value
  }

  const provider = {
    /** 这个后端不做本地沙箱限制 —— 边界是**目标账号自身的权限**。 */
    get sandboxMode() {
      return undefined
    },

    async resolve(path, opts = {}) {
      opts.signal?.throwIfAborted?.()
      const { remotePath } = toRemoteAbsolute(path, opts.cwd)
      try {
        // 用 realpath 归一化（符号链接、`~` 之外的情况），失败则退回字面路径
        const real = await routeFor(remotePath).transport.realpath(remotePath, { signal: opts.signal })
        return makeTarget(real)
      } catch (error) {
        if (error?.code === TRANSPORT_ERROR.NOT_FOUND) return makeTarget(remotePath)
        throw mapTransportError(error, remotePath, 'resolve')
      }
    },

    async stat(target, signal) {
      const remotePath = pathOf(target)
      try {
        const info = await routeFor(remotePath).transport.stat(remotePath, { signal })
        if (info === undefined) return undefined
        return { version: versionOf(info), type: typeOf(info), size: info.size ?? 0 }
      } catch (error) {
        if (error?.code === TRANSPORT_ERROR.NOT_FOUND) return undefined
        throw mapTransportError(error, remotePath, 'stat')
      }
    },

    async lstat(path, opts = {}, signal) {
      // 远程侧暂不区分 lstat / stat（SFTP 的 lstat 语义由 transport 决定）；
      // 这里显式走 stat 并保留注释，避免让人以为「已经处理了符号链接」。
      const { remotePath } = toRemoteAbsolute(path, opts.cwd)
      return provider.stat(makeTarget(remotePath), signal)
    },

    async readText(target, signal) {
      const remotePath = pathOf(target)
      try {
        return await routeFor(remotePath).transport.readFile(remotePath, { encoding: 'utf8', signal })
      } catch (error) {
        throw mapTransportError(error, remotePath, 'read')
      }
    },

    async listDir(target, signal) {
      const remotePath = pathOf(target)
      let entries
      try {
        entries = await routeFor(remotePath).transport.readdir(remotePath, { signal })
      } catch (error) {
        throw mapTransportError(error, remotePath, 'list')
      }
      return entries.map((entry) => {
        const childPath = remotePath === '/' ? `/${entry.name}` : `${remotePath}/${entry.name}`
        return {
          name: entry.name,
          type: entry.type === 'directory' ? 'directory' : entry.type === 'file' ? 'file' : 'other',
          target: makeTarget(childPath),
          ...entry.mtimeMs === undefined && entry.size === undefined
            ? {}
            : { version: versionOf(entry) },
          ...entry.size === undefined ? {} : { size: entry.size },
        }
      })
    },

    async writeText(target, content, expected, signal) {
      const remotePath = pathOf(target)
      const current = await provider.stat(target, signal).catch(() => undefined)

      // 版本守卫：与宿主 fs-local 同一套语义，**不静默忽略**。
      if (expected?.kind === 'replaceIfVersion') {
        if (current === undefined) {
          throw new WorldFsError(`cannot write "${remotePath}": file no longer exists`, FS_ERROR.STALE_VERSION, { displayPath: remotePath })
        }
        if (current.version !== expected.version) {
          throw new WorldFsError(`cannot write "${remotePath}": file changed since it was read`, FS_ERROR.STALE_VERSION, { displayPath: remotePath })
        }
      } else if (expected?.kind === 'createIfAbsent' && current !== undefined) {
        throw new WorldFsError(`cannot overwrite existing "${remotePath}" without reading it first`, FS_ERROR.NOT_OBSERVED, { displayPath: remotePath })
      }
      if (current !== undefined && current.type !== 'file') {
        throw new WorldFsError(`cannot write "${remotePath}": not a regular file`, FS_ERROR.NOT_REGULAR_FILE, { displayPath: remotePath })
      }

      const before = current === undefined ? null : await provider.readText(target, signal).catch(() => null)
      const routed = routeFor(remotePath)
      try {
        await routed.transport.writeFileAtomic(remotePath, content, { signal })
      } catch (error) {
        throw mapTransportError(error, remotePath, 'write')
      }
      const after = await provider.stat(target, signal).catch(() => undefined)
      syncToMirror(routed, remotePath, content)
      return {
        operation: current === undefined ? 'create' : 'update',
        version: after?.version ?? '',
        before,
        after: normalizeLineEndings(content),
      }
    },

    async editText(target, edit, expected, signal) {
      const remotePath = pathOf(target)
      const current = await provider.stat(target, signal)
      if (current === undefined) {
        throw new WorldFsError(`cannot edit "${remotePath}": file changed since it was read`, FS_ERROR.STALE_VERSION, { displayPath: remotePath })
      }
      if (current.type !== 'file') {
        throw new WorldFsError(`cannot edit "${remotePath}": not a regular file`, FS_ERROR.NOT_REGULAR_FILE, { displayPath: remotePath })
      }
      if (expected !== undefined && current.version !== expected.version) {
        throw new WorldFsError(`cannot edit "${remotePath}": file changed since it was read`, FS_ERROR.STALE_VERSION, { displayPath: remotePath })
      }

      const original = await provider.readText(target, signal)
      const edited = applyLiteralEdit(original, edit, remotePath)
      const routed = routeFor(remotePath)
      try {
        await routed.transport.writeFileAtomic(remotePath, edited.content, { signal })
      } catch (error) {
        throw mapTransportError(error, remotePath, 'edit')
      }
      const after = await provider.stat(target, signal).catch(() => undefined)
      syncToMirror(routed, remotePath, edited.content)
      return { version: after?.version ?? '', before: original, after: edited.content }
    },

    /** 远程侧暂不支持监听：宿主会显示「不支持」，而不是轮询假装支持。 */
    watch(target, changed, signal) {
      signal?.throwIfAborted?.()
      return Promise.reject(new WorldFsError(
        '远程文件系统不支持监听（请用手动刷新）',
        FS_ERROR.IO_ERROR,
        { displayPath: pathOf(target) },
      ))
    },

    /** 这个执行世界里的路径就是远程路径。 */
    processPath(target) {
      return pathOf(target)
    },

    /** 远程文件与宿主文件不是同一个文件，所以没有映射。 */
    processPathFromHostPath() {
      return undefined
    },

    fileUrl(target) {
      // 远程路径不是本地 file: URL；给一个稳定的伪 URL 便于标识。
      return `remote://${encodeURI(pathOf(target))}`
    },

    contains(parent, child) {
      const parentPath = pathOf(parent)
      const childPath = pathOf(child)
      const rel = posix.relative(parentPath, childPath)
      return rel === '' || (!rel.startsWith('..') && !posix.isAbsolute(rel))
    },
  }

  ctx.provide('fs', provider)
  log?.info?.('[world-fs] 隔离域 fs 已挂载（按路径路由，不绑固定连接）')
}

/**
 * 字面量编辑：与宿主同一套语义。
 *
 * 找不到 `oldString` → `FS_AMBIGUOUS_EDIT`（明确报错，不猜用户意图）；
 * 出现多次且未开 `replaceAll` → 同样拒绝，避免改错地方。
 *
 * @param {string} original
 * @param {{ oldString?: string, newString?: string, replaceAll?: boolean }} edit
 * @param {string} displayPath
 * @returns {{ content: string, occurrences: number }}
 */
export function applyLiteralEdit(original, edit, displayPath = '') {
  const oldString = edit?.oldString
  const newString = edit?.newString ?? ''
  if (typeof oldString !== 'string' || oldString === '') {
    throw new WorldFsError(`cannot edit "${displayPath}": old_string must be a non-empty string`, FS_ERROR.AMBIGUOUS_EDIT, { displayPath })
  }

  const occurrences = countOccurrences(original, oldString)
  if (occurrences === 0) {
    throw new WorldFsError(`cannot edit "${displayPath}": old_string was not found`, FS_ERROR.AMBIGUOUS_EDIT, { displayPath })
  }
  if (occurrences > 1 && edit?.replaceAll !== true) {
    throw new WorldFsError(
      `cannot edit "${displayPath}": old_string appears ${occurrences} times; make it unique or enable replace_all`,
      FS_ERROR.AMBIGUOUS_EDIT,
      { displayPath },
    )
  }
  const content = edit?.replaceAll === true
    ? original.split(oldString).join(newString)
    : original.replace(oldString, newString)
  return { content, occurrences }
}

/** 数不重叠的出现次数（`split` 的方式在 oldString 为空时不适用，调用方已挡住）。 */
function countOccurrences(haystack, needle) {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** 与宿主 `fs-local` 一致：写回的 `after` 报告归一化行尾后的内容。 */
function normalizeLineEndings(content) {
  return String(content).replace(/\r\n/g, '\n')
}
