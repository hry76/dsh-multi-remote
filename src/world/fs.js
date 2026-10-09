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
 *   - 拿不到 transport 就**抛错**，绝不回退（`requireTransport` 保证）。
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

import { requireTransport } from '../transport/registry.js'
import { TRANSPORT_ERROR } from '../transport/transport.js'
import { resolveRemotePath } from './translate.js'

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
 * `config.profileId` 指向连接档案；`config.remoteRoot` 是这台机器的项目根，
 * 用于把相对路径解析成绝对路径。
 */
export function apply(ctx, config = {}) {
  const profileId = config.profileId
  const remoteRoot = config.remoteRoot
  if (typeof profileId !== 'string' || profileId === '') {
    throw new Error('world-fs: config.profileId 必填（拿不到就拒绝挂载，绝不回退到本机）')
  }
  if (typeof remoteRoot !== 'string' || !remoteRoot.startsWith('/')) {
    throw new Error('world-fs: config.remoteRoot 必须是以 / 开头的绝对 POSIX 路径')
  }

  const log = ctx.logger
  const transport = () => requireTransport(profileId)

  /** 本机锚点目录：会话 cwd 就是它，工具会把路径按它来传（与 world-shell 同一个坑）。 */
  const localAnchorPath = typeof config.localAnchorPath === 'string' ? config.localAnchorPath : undefined

  /**
   * 把任意输入路径解析成远程绝对 POSIX 路径。
   *
   * ⚠️ **不能只判断「是不是以 / 开头」**：`tool-fs` 会把**会话 cwd**（= 本机锚点目录，
   * 例如 `D:\...\anchors\mr-x`）传下来，模型也自然会用锚点形态的路径。
   * 直接用的话会拼出 `D:/.../anchors/mr-x/src/a.js` 这种远程根本不存在的路径。
   * 所以走共享翻译：锚点 → 远程根，锚点之下 → 远程根 + 相对部分。
   */
  const toRemoteAbsolute = (path, cwd) => {
    const raw = String(path ?? '')
    if (raw === '') throw new WorldFsError('file_path must be a non-empty string', FS_ERROR.NOT_FOUND)
    return resolveRemotePath(raw, {
      remoteRoot,
      localAnchorPath,
      ...cwd === undefined ? {} : { cwd },
      log,
    })
  }

  /** 构造一个 target：`targetKey` 是远程真实路径，`displayPath` 给模型/界面看。 */
  const makeTarget = (remotePath) => ({ targetKey: remotePath, displayPath: remotePath })

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
      const absolute = toRemoteAbsolute(path, opts.cwd)
      try {
        // 用 realpath 归一化（符号链接、`~` 之外的情况），失败则退回字面路径
        const real = await transport().realpath(absolute, { signal: opts.signal })
        return makeTarget(real)
      } catch (error) {
        if (error?.code === TRANSPORT_ERROR.NOT_FOUND) return makeTarget(absolute)
        throw mapTransportError(error, absolute, 'resolve')
      }
    },

    async stat(target, signal) {
      const remotePath = pathOf(target)
      try {
        const info = await transport().stat(remotePath, { signal })
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
      return provider.stat(makeTarget(toRemoteAbsolute(path, opts.cwd)), signal)
    },

    async readText(target, signal) {
      const remotePath = pathOf(target)
      try {
        return await transport().readFile(remotePath, { encoding: 'utf8', signal })
      } catch (error) {
        throw mapTransportError(error, remotePath, 'read')
      }
    },

    async listDir(target, signal) {
      const remotePath = pathOf(target)
      let entries
      try {
        entries = await transport().readdir(remotePath, { signal })
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
      try {
        await transport().writeFileAtomic(remotePath, content, { signal })
      } catch (error) {
        throw mapTransportError(error, remotePath, 'write')
      }
      const after = await provider.stat(target, signal).catch(() => undefined)
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
      try {
        await transport().writeFileAtomic(remotePath, edited.content, { signal })
      } catch (error) {
        throw mapTransportError(error, remotePath, 'edit')
      }
      const after = await provider.stat(target, signal).catch(() => undefined)
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
  log?.info?.('[world-fs] 隔离域 fs 已挂载（档案 %s，根 %s）', profileId, remoteRoot)
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
