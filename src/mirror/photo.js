/**
 * 照片层 —— agent 读写远程文件时，顺手在锚点镜像里留一份。
 *
 * **这是整个镜像策略里最省的一层**：agent 每次读远程文件，内容本来就要传给它看，
 * 所以「顺手写一份到镜像」不产生任何额外网络开销。
 *
 * 两条设计原则：
 *   1. **agent 从不读镜像** —— 镜像只给界面看。正因如此，这里可以单向、懒加载、
 *      容忍过期，**不需要任何冲突检测**（这是本项目比纯镜像方案轻得多的根本原因）。
 *   2. **失败绝不影响 agent** —— 镜像只是「照片」。写照片失败时 agent 的读写必须照常成功，
 *      所以本模块所有函数都返回结果对象、**不抛异常**（除了参数本身非法）。
 *      把镜像故障升级成 agent 故障是本末倒置。
 */
import { mkdir, writeFile, readFile, utimes, stat, lstat, realpath, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

import { assertInsideAnchor, toAnchorPath } from './paths.js'

/** 照片操作的结果码。 */
export const PHOTO_RESULT = {
  /** 写入成功。 */
  WRITTEN: 'written',
  /** 内容与镜像里已有的完全一致，跳过写入。 */
  UNCHANGED: 'unchanged',
  /** 超过上限，没写。 */
  SKIPPED_OVERSIZED: 'skipped-oversized',
  /** 目标在镜像里是目录，写不进去（远程侧类型变了）。 */
  SKIPPED_NOT_FILE: 'skipped-not-file',
  /** 写入失败（已记录，不影响 agent）。 */
  FAILED: 'failed',
}

/**
 * 往镜像里写一份「照片」。
 *
 * @param {object} options
 * @param {string} options.anchorPath 锚点目录（本地绝对路径）
 * @param {string} options.relPath 相对远程根的 POSIX 路径
 * @param {string|Buffer} options.content 内容 —— **必须复用 agent 本来就要读的那份**，
 *   绝不为写镜像额外发一次远程读
 * @param {number} [options.maxBytes] 单文件上限；超过只跳过，不截断
 * @param {number} [options.mtimeMs] 远程 mtime；给了就对齐本地 mtime
 * @param {boolean} [options.skipUnchanged] 内容一致时跳过写入（默认 true）
 * @param {string} [options.resolvedAnchor] 已解析的锚点真实路径；给了就做围栏判定
 * @returns {Promise<{ result: string, bytes?: number, error?: string }>}
 */
export async function writePhoto(options) {
  const {
    anchorPath,
    relPath,
    content,
    maxBytes,
    mtimeMs,
    skipUnchanged = true,
    resolvedAnchor,
  } = options

  const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length
  if (maxBytes !== undefined && bytes > maxBytes) {
    return { result: PHOTO_RESULT.SKIPPED_OVERSIZED, bytes }
  }

  const localPath = toAnchorPath(anchorPath, relPath)

  // 目标已经是目录 → 写不进去。这说明远程侧「文件变目录」了，
  // 属于真实的状态漂移；返回明确结果让调用方决定是否整棵刷新。
  if (await isDirectory(localPath)) {
    return { result: PHOTO_RESULT.SKIPPED_NOT_FILE, bytes }
  }

  try {
    if (skipUnchanged && (await isSameContent(localPath, content))) {
      return { result: PHOTO_RESULT.UNCHANGED, bytes }
    }

    await mkdir(dirname(localPath), { recursive: true })
    if (resolvedAnchor !== undefined) {
      // 围栏：必须在目录建出来、能解析真实路径之后判定。
      await assertWritable(resolvedAnchor, localPath, relPath)
    }
    await writeFile(localPath, content)
    if (mtimeMs !== undefined) {
      const seconds = mtimeMs / 1000
      await utimes(localPath, seconds, seconds)
    }
    return { result: PHOTO_RESULT.WRITTEN, bytes }
  } catch (error) {
    // **镜像失败不影响 agent**：只回报，不抛。
    return {
      result: PHOTO_RESULT.FAILED,
      bytes,
      error: `${error?.code ?? ''} ${error?.message ?? error}`.trim(),
    }
  }
}

/**
 * 批量写照片。逐条独立，一条失败不影响其余。
 *
 * @param {object} options
 * @param {string} options.anchorPath
 * @param {Array<{ relPath: string, content: string|Buffer, mtimeMs?: number }>} options.photos
 * @param {number} [options.maxBytes]
 * @param {boolean} [options.skipUnchanged]
 * @param {string} [options.resolvedAnchor]
 * @returns {Promise<{ written: number, unchanged: number, skipped: number, failed: number, results: object[] }>}
 */
export async function writePhotos(options) {
  const { anchorPath, photos, maxBytes, skipUnchanged, resolvedAnchor } = options
  const results = []
  let written = 0
  let unchanged = 0
  let skipped = 0
  let failed = 0

  for (const photo of photos) {
    const outcome = await writePhoto({
      anchorPath,
      relPath: photo.relPath,
      content: photo.content,
      mtimeMs: photo.mtimeMs,
      maxBytes,
      skipUnchanged,
      resolvedAnchor,
    })
    results.push({ relPath: photo.relPath, ...outcome })
    if (outcome.result === PHOTO_RESULT.WRITTEN) written += 1
    else if (outcome.result === PHOTO_RESULT.UNCHANGED) unchanged += 1
    else if (outcome.result === PHOTO_RESULT.FAILED) failed += 1
    else skipped += 1
  }

  return { written, unchanged, skipped, failed, results }
}

/**
 * 删掉镜像里的一个文件（agent 在远程删了文件时顺手同步）。
 *
 * 刻意**不递归删目录**：镜像里可能有别的照片，而且删目录风险高。
 * 目录的清理交给手动刷新或整棵重建。
 *
 * @param {{ anchorPath: string, relPath: string, resolvedAnchor?: string }} options
 * @returns {Promise<{ result: string, error?: string }>}
 */
export async function removePhoto(options) {
  const { anchorPath, relPath, resolvedAnchor } = options
  const localPath = toAnchorPath(anchorPath, relPath)
  try {
    if (resolvedAnchor !== undefined) await assertWritable(resolvedAnchor, localPath, relPath)
    await unlink(localPath)
    return { result: 'removed' }
  } catch (error) {
    if (error?.code === 'ENOENT') return { result: 'absent' }
    return { result: PHOTO_RESULT.FAILED, error: `${error?.code ?? ''} ${error?.message ?? error}`.trim() }
  }
}

/** 目标是否存在且是目录。 */
async function isDirectory(path) {
  try {
    const info = await lstat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

/** 镜像里已有内容是否与将要写的一模一样。 */
async function isSameContent(path, content) {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    const expected = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    if (info.size !== expected.length) return false
    const existing = await readFile(path)
    return existing.equals(expected)
  } catch {
    return false
  }
}

/** 落盘前的围栏：解析父目录真实路径后再判定。 */
async function assertWritable(resolvedAnchor, localPath, relPath) {
  const parent = dirname(localPath)
  let resolvedParent
  try {
    resolvedParent = await realpath(parent)
  } catch {
    return
  }
  assertInsideAnchor(resolvedAnchor, resolvedParent, { remotePath: relPath })
}
