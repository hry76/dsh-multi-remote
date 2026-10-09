/**
 * 「本机锚点路径」↔「远程路径」的翻译 —— 供 `world/shell` 与 `world/fs` 共用。
 *
 * ## 为什么需要
 *
 * 会话的 cwd 是**本机锚点目录**（例如 `D:\...\anchors\mr-x`），因为用户是把锚点
 * 当工作区打开的。于是工具传下来的路径有两种形态：
 *
 * 1. **本机锚点形态**：`D:\...\anchors\mr-x\src\a.js`，或相对路径 `src\a.js`
 *    （工具会用会话 cwd 去拼）
 * 2. **远程形态**：`/home/user/proj/src/a.js`（模型自己写了远程路径）
 *
 * 而锚点目录**就是**远程根的镜像，所以映射关系是直接的：
 *
 * | 输入 | 输出 |
 * |---|---|
 * | 等于锚点 | 远程根 |
 * | 锚点之下 | 远程根 + 相对部分 |
 * | 已经是远程绝对 POSIX 路径 | 原样 |
 * | 其他本地路径（不认识） | 远程根（**并记日志，不静默**） |
 *
 * 这套逻辑原本只写在 `world/shell.js` 里（`tool-bash` 的 workdir 踩过这个坑：
 * 远程 bash 报 `cd: D:\...\anchor: 没有那个文件或目录`）。
 * 现在 `world/fs.js` 也要用同一条规则（`tool-fs` 同样会传会话 cwd），
 * 所以抽到这里 —— **一份实现，两处使用**，不会再漂移。
 */
import posix from 'node:path/posix'

/** 把路径里的反斜杠统一成正斜杠，并去掉结尾的斜杠。 */
export function normalizeLocalPath(input) {
  return String(input ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 是不是远程绝对 POSIX 路径。 */
export function isRemoteAbsolute(value) {
  return typeof value === 'string' && value.startsWith('/')
}

/**
 * 判断一个路径是否**位于锚点之下**（含锚点本身）。
 *
 * Windows 上比较时忽略大小写 —— 同一个目录会有 `D:\x` / `d:\x` 两种写法。
 *
 * @returns {undefined | string} 相对锚点的部分（锚点本身返回 `''`）；不在锚点下返回 undefined
 */
export function anchorRelative(value, localAnchorPath) {
  if (typeof localAnchorPath !== 'string' || localAnchorPath === '') return undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined

  const anchor = normalizeLocalPath(localAnchorPath)
  const target = normalizeLocalPath(value)
  if (anchor === '') return undefined

  const isWindows = process.platform === 'win32'
  const same = isWindows ? anchor.toLowerCase() === target.toLowerCase() : anchor === target
  if (same) return ''
  const under = isWindows
    ? target.toLowerCase().startsWith(`${anchor.toLowerCase()}/`)
    : target.startsWith(`${anchor}/`)
  if (!under) return undefined
  return target.slice(anchor.length + 1)
}

/**
 * 把一个**本机锚点形态**的路径翻译成远程路径。
 *
 * 不是锚点形态（也不在锚点之下）时返回 `undefined` —— 由调用方决定怎么兜底。
 *
 * @param {string} value
 * @param {{ localAnchorPath?: string, remoteRoot: string }} options
 * @returns {string|undefined}
 */
export function anchorToRemote(value, options) {
  const relative = anchorRelative(value, options?.localAnchorPath)
  if (relative === undefined) return undefined
  const root = String(options.remoteRoot).replace(/\/+$/, '')
  return relative === '' ? root : `${root}/${relative}`
}

/**
 * 把工具传下来的路径解析成**远程绝对路径**（fs 用）。
 *
 * @param {string} path 工具给的路径（绝对或相对）
 * @param {object} options
 * @param {string} options.remoteRoot
 * @param {string} [options.cwd] 工具会传会话 cwd（= 本机锚点）
 * @param {string} [options.localAnchorPath]
 * @param {{ warn?: Function }} [options.log]
 * @returns {string}
 */
export function resolveRemotePath(path, options) {
  const raw = String(path ?? '').trim()
  if (raw === '') return String(options.remoteRoot)

  // 1) 已经是远程绝对路径 —— 原样
  if (isRemoteAbsolute(raw)) return posix.normalize(raw)

  // 2) 整个路径就是锚点形态（工具偶尔会给绝对的本机路径）
  const direct = anchorToRemote(raw, options)
  if (direct !== undefined) return posix.normalize(direct)

  // 3) 相对路径：基准取 cwd 的远程翻译
  const fromCwd = anchorToRemote(options.cwd, options)
  const base = fromCwd ?? (isRemoteAbsolute(options.cwd) ? options.cwd : options.remoteRoot)
  return posix.normalize(posix.join(base, raw))
}

/**
 * 把 workdir 归一成远程路径（shell 用）。
 *
 * 与 `resolveRemotePath` 的区别：workdir 一定是一个**目录**，拿不准时回退到远程根，
 * 而不是拼一个相对路径上去。
 *
 * @param {string|undefined} workdir
 * @param {{ remoteRoot: string, localAnchorPath?: string, log?: { warn?: Function } }} options
 * @returns {string}
 */
export function toRemoteWorkdir(workdir, options) {
  const remoteRoot = options.remoteRoot
  if (typeof workdir !== 'string' || workdir.trim() === '') return remoteRoot
  const value = workdir.trim()

  if (isRemoteAbsolute(value)) return value

  const translated = anchorToRemote(value, options)
  if (translated !== undefined) return translated

  // 不认识的本地路径：回退到远程根，但**明确记日志**，不静默
  options.log?.warn?.('[world] workdir %s 不是远程路径，已改用远程根 %s', value, remoteRoot)
  return remoteRoot
}
