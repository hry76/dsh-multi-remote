/**
 * 格局层 —— 打开工作区时，把远程的**目录结构**（以及小文件内容）拉进锚点目录。
 *
 * 目标（「格局层」）：
 *   - 文件树能显示远程目录结构
 *   - `@` 补全能列出远程文件
 *   - 小文本文件顺带拉内容；大文件只留占位
 *
 * 三条从参考项目的事故里学到的硬要求（不是可选优化）：
 *   1. **四重边界**：深度、条目数、单文件字节、**墙钟时间**。参考项目只有三重、
 *      没有墙钟预算也没有取消 —— 结果是遍历不可中断，会话永久卡在 running。
 *   2. **失败必须上报，不许当成空目录**：`readdir` 失败被吞掉 = 静默丢整棵子树，
 *      界面看起来「这个目录是空的」，用户永远不知道丢了东西。
 *   3. **取消是终态**：abort 之后不许转去走更慢的回退路径，否则取消等于没取消。
 *
 * 本模块**不做任何本地写入**：遍历与落盘分开，遍历可以拿假 transport 单测。
 * 落盘在 `materializeTree()` 里，它负责围栏、mtime 对齐与逐目录检查点。
 */
import { mkdir, writeFile, utimes, realpath, stat, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { posix } from 'node:path'

import { BUILTIN_IGNORES, IgnoreRules } from './ignore.js'

/**
 * 占位文件的标记行（放在第一行）。
 *
 * 镜像里出现它 = **「这个文件在远端，但内容没同步到本地」**。
 *
 * 为什么要有占位（2026-10-07 用户实测反馈）：
 * 原来超限的文件**直接跳过**，于是它们在界面的文件树里**根本不显示** ——
 * 用户以为文件不存在。有了占位：文件能看见，点开能看到一句说明
 * （「在远端、多大、怎么查看」），而不是一片空白。
 */
export const PLACEHOLDER_MARKER = '<!-- dsh-multi-remote:not-synced -->'

/** 人类可读的大小。 */
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return String(bytes)
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * 占位文件的内容。
 *
 * 刻意写成**人话**：用户点开一个 73 MB 的网格文件时，
 * 需要立刻知道「它没坏、它在远端、我该怎么看」。
 */
export function placeholderContent({ relPath, remoteRoot, size, capBytes }) {
  return [
    PLACEHOLDER_MARKER,
    `这个文件没有同步到本地镜像。`,
    '',
    `远端大小：${formatBytes(size)}（单文件上限 ${formatBytes(capBytes)}）`,
    `远端路径：${posix.join(remoteRoot, relPath)}`,
    '',
    '它**只在远端** —— 内容没有拉下来（避免为了显示一个文件把几十 MB 搬过来）。',
    '要看或改它，直接在会话里让 agent 读（agent 的文件读写走的是远端，不受这里限制），',
    '或者在会话里用 bash 查看（head / less / file / python 都行）。',
    '',
  ].join('\n')
}

/** 判断一段内容是不是占位。 */
export function isPlaceholderText(text) {
  return String(text ?? '').startsWith(PLACEHOLDER_MARKER)
}

/**
 * 本地这个文件是不是占位（只读头部几十字节，不整个读进来）。
 *
 * @param {string} localPath
 * @returns {Promise<boolean>}
 */
async function localIsPlaceholder(localPath) {
  let handle
  try {
    handle = await open(localPath, 'r')
    const buffer = Buffer.alloc(PLACEHOLDER_MARKER.length)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return isPlaceholderText(buffer.subarray(0, bytesRead).toString('utf8'))
  } catch {
    // 读不到就当「不是占位」—— 后面的逻辑会因为文件不存在而正常补拉
    return false
  } finally {
    // 关句柄失败不影响结果：这里已是收尾路径，真正的错误在上面已经抛/返回了
    await handle?.close().catch(() => {})
  }
}

/**
 * 「文本类」文件的扩展名白名单 —— 后台补拉只拉这些。
 *
 * 为什么不按内容嗅探：那要先读一段（多一次往返），而且二进制判定的边界很模糊。
 * 按扩展名足够准：**用户真正会「看」的文件**基本都在这里；
 * 网格/数据库/压缩包这类大二进制不在此列（它们本来也不适合在界面里读）。
 */
export const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'adoc',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'mts', 'cts',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'py', 'pyi', 'ipynb', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx',
  'java', 'kt', 'kts', 'scala', 'go', 'rs', 'rb', 'php', 'pl', 'lua', 'r', 'jl',
  'cs', 'vb', 'fs', 'fsx', 'swift', 'm', 'mm', 'dart', 'ex', 'exs', 'erl', 'clj',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'thrift',
  'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'styl', 'vue', 'svelte',
  'xml', 'svg', 'plist', 'gradle', 'cmake', 'mk', 'makefile', 'dockerfile', 'gitignore',
  'csv', 'tsv', 'log', 'diff', 'patch', 'tex', 'bib', 'org',
])

/**
 * 这个相对路径算不算「文本类」。
 *
 * 无扩展名的文件按**文件名**判断（`Makefile`、`Dockerfile`、`.gitignore` 等）。
 *
 * @param {string} relPath
 * @returns {boolean}
 */
export function isTextLike(relPath) {
  const base = posix.basename(String(relPath ?? '')).toLowerCase()
  const dot = base.lastIndexOf('.')
  if (dot > 0) return TEXT_EXTENSIONS.has(base.slice(dot + 1))   // `a.md` → `md`
  if (dot === 0) return TEXT_EXTENSIONS.has(base.slice(1))       // `.gitignore` → `gitignore`
  return TEXT_EXTENSIONS.has(base)                               // `Makefile` / `Dockerfile`
}

import { assertInsideAnchor, toAnchorPath, toRelativeRemotePath } from './paths.js'
import { TRANSPORT_ERROR, TransportError } from '../transport/transport.js'

/** 默认边界。刻意保守：格局层的目的是「让界面有东西看」，不是把整个仓库搬下来。 */
export const DEFAULT_TREE_BOUNDS = {
  /** 最大目录深度（根为 0）。 */
  maxDepth: 12,
  /** 最多访问多少个条目（文件 + 目录）。 */
  maxEntries: 20_000,
  /** 单文件最大字节数；超过只留占位，不拉内容。 */
  maxFileBytes: 256 * 1024,
  /** 墙钟预算（毫秒）。到点就停，并标记 `truncated`。 */
  maxDurationMs: 30_000,
}

/** 遍历被边界截断的原因。 */
export const TRUNCATION_REASON = {
  DEPTH: 'max-depth',
  ENTRIES: 'max-entries',
  TIME: 'max-duration',
}

/**
 * 遍历一棵远程目录树。
 *
 * @param {object} options
 * @param {import('../transport/transport.js').Transport} options.transport
 * @param {string} options.remoteRoot 远程根（绝对 POSIX 路径）
 * @param {IgnoreRules} [options.ignore] 忽略规则；默认只用内置兜底规则
 * @param {typeof DEFAULT_TREE_BOUNDS} [options.bounds]
 * @param {AbortSignal} [options.signal]
 * @param {(entry: TreeEntry) => void|Promise<void>} [options.onEntry] 每访问一个条目回调一次
 * @param {() => number} [options.now] 注入时钟，便于测试墙钟预算
 * @returns {Promise<TreeWalkResult>}
 */
export async function walkRemoteTree(options) {
  const {
    transport,
    remoteRoot,
    ignore = BUILTIN_IGNORES,
    bounds = DEFAULT_TREE_BOUNDS,
    signal,
    onEntry,
    now = () => Date.now(),
  } = options

  const startedAt = now()
  const deadline = startedAt + bounds.maxDurationMs

  /** @type {TreeEntry[]} */
  const entries = []
  /** @type {{ path: string, message: string, code: string }[]} */
  const errors = []
  const truncation = { truncated: false, reasons: /** @type {string[]} */ ([]) }

  const markTruncated = (reason) => {
    truncation.truncated = true
    if (!truncation.reasons.includes(reason)) truncation.reasons.push(reason)
  }

  /** 统一的取消检查：abort 是终态，立刻抛出，不做任何回退。 */
  const throwIfAborted = () => {
    if (signal?.aborted === true) {
      throw new TransportError(TRANSPORT_ERROR.ABORTED, '镜像遍历已被取消', {
        operation: 'walkRemoteTree',
        target: remoteRoot,
      })
    }
  }

  // 队列式（广度优先）而不是递归：深度可控，且墙钟到点能立刻停。
  /** @type {{ relPath: string, depth: number }[]} */
  const queue = [{ relPath: '', depth: 0 }]
  let visited = 0

  while (queue.length > 0) {
    throwIfAborted()
    if (now() > deadline) {
      markTruncated(TRUNCATION_REASON.TIME)
      break
    }
    if (visited >= bounds.maxEntries) {
      markTruncated(TRUNCATION_REASON.ENTRIES)
      break
    }

    const { relPath, depth } = queue.shift()
    const remotePath = relPath === '' ? remoteRoot : `${remoteRoot.replace(/\/+$/, '')}/${relPath}`

    let children
    try {
      children = await transport.readdir(remotePath, { signal })
    } catch (error) {
      if (isAbort(error, signal)) throw abortError('walkRemoteTree', remotePath, error)
      // **不把失败当空目录**：记一条错误，继续走别的分支。
      errors.push({
        path: remotePath,
        code: error?.code ?? TRANSPORT_ERROR.UNKNOWN,
        message: String(error?.message ?? error),
      })
      continue
    }

    for (const child of children) {
      throwIfAborted()
      if (visited >= bounds.maxEntries) {
        markTruncated(TRUNCATION_REASON.ENTRIES)
        break
      }
      if (now() > deadline) {
        markTruncated(TRUNCATION_REASON.TIME)
        break
      }
      visited += 1

      const childRel = relPath === '' ? child.name : `${relPath}/${child.name}`
      const isDirectory = child.type === 'directory'

      // 忽略判定发生在**目录本身**上：命中的目录整棵剪掉，不再下潜。
      // 这与 git 一致；否则一条 `!important.txt` 就能把 node_modules 整个拉回来。
      if (ignore.ignores(childRel, { isDirectory })) continue

      /** @type {TreeEntry} */
      const entry = {
        relPath: childRel,
        type: child.type,
        depth: depth + 1,
        size: typeof child.size === 'number' ? child.size : undefined,
        mtimeMs: typeof child.mtimeMs === 'number' ? child.mtimeMs : undefined,
      }
      entries.push(entry)
      if (onEntry !== undefined) await onEntry(entry)

      if (isDirectory) {
        if (depth + 1 >= bounds.maxDepth) {
          markTruncated(TRUNCATION_REASON.DEPTH)
          continue
        }
        queue.push({ relPath: childRel, depth: depth + 1 })
      }
    }
  }

  return {
    entries,
    errors,
    truncated: truncation.truncated,
    reasons: truncation.reasons,
    stats: {
      visited,
      directories: entries.filter((entry) => entry.type === 'directory').length,
      files: entries.filter((entry) => entry.type === 'file').length,
      other: entries.filter((entry) => entry.type === 'other').length,
      durationMs: now() - startedAt,
    },
  }
}

/**
 * 把遍历结果落进锚点目录：建目录骨架 + 写小文件内容。
 *
 * 与遍历分开的理由：遍历是纯逻辑（可假 transport 单测），落盘涉及围栏与 mtime，
 * 是真正碰本地磁盘的地方。
 *
 * ## 拉取是并发的（2026-10-09 实测改的）
 *
 * 旧版在 `onEntry` 里串行「readFile → 写盘」，197 个小文件在 WSL 上要 22 秒 ——
 * 每个文件一次远程调用，全部排成一队。现在改成两阶段：
 *
 *   1. **遍历阶段**（串行，树结构只能按层走）：建目录骨架、判占位、判指纹跳过、
 *      把「要拉内容的文件」收进队列 —— 这些判断全是本地/已拿到的元数据，零往返。
 *   2. **拉取阶段**（并发）：按 `transport.readConcurrency` 路同时发 readFile，
 *      谁回来谁写盘。SSH 是长连接（SFTP 天然支持流水线），收益直接；
 *      WSL 自带 4 槽位硬限流（见 `#acquire`），这里发再多它也只放行 4 路 ——
 *      所以镜像层**不需要**自己再限。
 *
 * `readFile` 走 `knownSize`（遍历已拿到 size），跳过每个文件一次的 stat 往返。
 *
 * @param {object} options
 * @param {import('../transport/transport.js').Transport} options.transport
 * @param {string} options.anchorPath 锚点目录（本地绝对路径）
 * @param {string} options.remoteRoot
 * @param {IgnoreRules} [options.ignore]
 * @param {typeof DEFAULT_TREE_BOUNDS} [options.bounds]
 * @param {AbortSignal} [options.signal]
 * @param {(progress: { dir: string, written: number }) => void|Promise<void>} [options.onDirectoryDone]
 *   每处理完一个目录回调一次 —— 让调用方**逐目录做检查点**，而不是整轮跑完才存状态。
 * @param {(entry: TreeEntry) => void|Promise<void>} [options.onFileWritten]
 * @param {(progress: { phase: 'walk'|'fetch', visited?: number, done?: number, total?: number }) => void} [options.onProgress]
 *   进度上报（供界面的「正在打开」进度条用）：
 *   - `walk`：遍历阶段，每访问一个条目回调一次 `{ phase:'walk', visited }`（无 total，因为不知道总数）
 *   - `fetch`：拉取阶段，每写一个文件回调一次 `{ phase:'fetch', done, total }`
 * @param {Record<string, string>} [options.manifest]
 *   上次刷新时每个文件的「内容指纹」—— `size:floor(mtime 秒)`。
 *   与本次一致的文件**不再拉内容**（只保留目录骨架）。这是刷新变快的关键，
 *   也是唯一能安全跳过的手段：只比 size 会漏掉「改了内容但字节数没变」的编辑。
 * @returns {Promise<TreeMaterializeResult>}
 */
export async function materializeTree(options) {
  const {
    transport,
    anchorPath,
    remoteRoot,
    ignore = BUILTIN_IGNORES,
    bounds = DEFAULT_TREE_BOUNDS,
    signal,
    onDirectoryDone,
    onFileWritten,
    onProgress,
    manifest = {},
  } = options

  await mkdir(anchorPath, { recursive: true })
  // 围栏的基准必须是**解析后**的锚点真实路径（防符号链接逃逸）。
  const resolvedAnchor = await realpath(anchorPath)

  /** @type {TreeEntry[]} */
  const written = []
  /** @type {TreeEntry[]} */
  const skeleton = []
  /** @type {TreeEntry[]} */
  const oversized = []
  /** @type {TreeEntry[]} 写了占位的（远端有、本地只有说明） */
  const placeholders = []
  /** @type {TreeEntry[]} */
  const unchanged = []
  /** @type {Record<string, string>} 本次刷新后的指纹表 */
  const nextManifest = {}
  /** @type {{ path: string, code: string, message: string }[]} */
  const errors = []

  /** @type {TreeEntry[]} 要拉内容的文件（在阶段 2 处理） */
  const toFetch = []

  /** 遍历阶段已访问的条目数（进度上报用）。 */
  let walkVisited = 0

  /**
   * 处理一个条目（快路与标准路**共用**）：建目录骨架 / 超限写占位 /
   * 指纹跳过 / 收集要拉内容的文件。**不碰网络读内容** —— 那是阶段 2 的事。
   * @param {TreeEntry} entry
   */
  const processEntry = async (entry) => {
    walkVisited += 1
    onProgress?.({ phase: 'walk', visited: walkVisited })
    const localPath = toAnchorPath(resolvedAnchor, entry.relPath)
    if (entry.type === 'directory') {
      await mkdir(localPath, { recursive: true })
      skeleton.push(entry)
      return
    }
    if (entry.type !== 'file') {
      // 符号链接 / FIFO / socket：不搬内容，也不建占位文件。
      // 宿主 `@` 补全本来就不索引符号链接目录，建了反而误导。
      return
    }

    const fingerprint = fingerprintOf(entry)
    nextManifest[entry.relPath] = fingerprint

    const size = entry.size ?? 0
    if (size > bounds.maxFileBytes) {
      oversized.push(entry)
      // **写占位**，让文件在界面的文件树里看得见。
      try {
        const exists = await fileExists(localPath)
        if (!exists || (await localIsPlaceholder(localPath))) {
          await mkdir(dirname(localPath), { recursive: true })
          await assertWritable(resolvedAnchor, localPath, entry.relPath)
          await writeFile(localPath, placeholderContent({
            relPath: entry.relPath,
            remoteRoot,
            size,
            capBytes: bounds.maxFileBytes,
          }))
          // mtime 与远端对齐 —— 否则文件树按时间排序时它会跑到最前面
          if (entry.mtimeMs !== undefined) {
            const seconds = entry.mtimeMs / 1000
            await utimes(localPath, seconds, seconds)
          }
          placeholders.push(entry)
        }
      } catch (error) {
        if (isAbort(error, signal)) throw abortError('materializeTree', entry.relPath, error)
        errors.push({
          path: entry.relPath,
          code: error?.code ?? TRANSPORT_ERROR.UNKNOWN,
          message: String(error?.message ?? error),
        })
      }
      return
    }

    // 指纹没变 → 内容没变（骨架已有）→ 跳过远程读。
    if (manifest[entry.relPath] === fingerprint && (await fileExists(localPath))) {
      unchanged.push(entry)
      return
    }

    // 要拉内容：先建好父目录，收进队列。
    await mkdir(dirname(localPath), { recursive: true })
    toFetch.push(entry)
  }

  // ── 阶段 1：遍历拿元数据（快路 walkTree 或标准 walkRemoteTree）───────────
  // 快路只有 SSH 有（find -printf 一次拿整棵树结构）；失败静默退回标准路。
  let walk = null
  if (typeof transport.walkTree === 'function') {
    try {
      const fast = await transport.walkTree(remoteRoot, {
        maxEntries: bounds.maxEntries,
        maxDepth: bounds.maxDepth,
        timeoutMs: bounds.maxDurationMs,
        signal,
      })
      // 快路拿到的是**元数据**（无内容），与标准遍历同构 → 统一走 processEntry。
      //
      // ⚠️ 但 find 拿的是**全量未过滤**（含 .gitignore 该忽略的目录及其子孙）——
      // 标准遍历在「遍历时逐目录剪枝」，快路没有这一步，必须在这里补上：
      // 按 relPath 排序（父先于子），遇到「被忽略的目录」就把它整棵剪掉（连同子孙）。
      const pruned = new Set() // 被剪掉的目录前缀
      const sorted = [...fast.entries].sort((a, b) => a.relPath.localeCompare(b.relPath))
      const entries = []
      for (const item of sorted) {
        // 落在已剪枝目录下 → 跳过（父目录已判忽略）
        let underPruned = false
        for (const prefix of pruned) {
          if (item.relPath === prefix || item.relPath.startsWith(`${prefix}/`)) {
            underPruned = true
            break
          }
        }
        if (underPruned) continue

        const isDir = item.type === 'directory'
        // 目录被忽略 → 整棵剪掉；文件被忽略 → 跳过自己
        if (ignore.ignores(item.relPath, { isDirectory: isDir })) {
          if (isDir) pruned.add(item.relPath)
          continue
        }

        try {
          await processEntry(item)
          entries.push(item)
        } catch (error) {
          if (isAbort(error, signal)) throw abortError('materializeTree', item.relPath, error)
          errors.push({
            path: item.relPath,
            code: error?.code ?? TRANSPORT_ERROR.UNKNOWN,
            message: String(error?.message ?? error),
          })
        }
      }
      walk = {
        entries,
        errors: [],
        truncated: fast.truncated,
        reasons: fast.truncated ? [TRUNCATION_REASON.ENTRIES] : [],
        stats: {
          visited: entries.length,
          directories: entries.filter((e) => e.type === 'directory').length,
          files: entries.filter((e) => e.type === 'file').length,
          other: entries.filter((e) => e.type === 'other').length,
          durationMs: fast.durationMs,
          viaFind: true,
        },
      }
    } catch (error) {
      if (isAbort(error, signal)) throw abortError('materializeTree', remoteRoot, error)
      // 探测失败（没 GNU find / 权限不够）→ 退回标准路，**不报错**
      walk = null
    }
  }

  if (walk === null) {
    walk = await walkRemoteTree({
      transport,
      remoteRoot,
      ignore,
      bounds,
      signal,
      onEntry: processEntry,
    })
  }

  // ── 阶段 2：拉取 + 写盘（仅标准路需要；快路在阶段 0 已做完骨架与写盘）───
  // 优先级：transport 有 readFilesBatch（WSL）→ 批量；否则并发逐个（SSH/Docker）。
  // 每个任务独立容错：单个文件失败不放弃整棵树（与旧版语义一致）。
  const writeOne = async (entry, content) => {
    const localPath = toAnchorPath(resolvedAnchor, entry.relPath)
    await assertWritable(resolvedAnchor, localPath, entry.relPath)
    await writeFile(localPath, content)
    if (entry.mtimeMs !== undefined) {
      const seconds = entry.mtimeMs / 1000
      await utimes(localPath, seconds, seconds)
    }
    written.push(entry)
    onProgress?.({ phase: 'fetch', done: written.length, total: toFetch.length })
    if (onFileWritten !== undefined) await onFileWritten(entry)
  }

  const noteError = (entry, error) => {
    errors.push({
      path: entry.relPath,
      code: error?.code ?? TRANSPORT_ERROR.UNKNOWN,
      message: String(error?.message ?? error),
    })
  }

  // 进入拉取阶段前报一次「总量」（done=0, total=N），让界面的进度条有分母
  if (toFetch.length > 0) {
    onProgress?.({ phase: 'fetch', done: 0, total: toFetch.length })
  }

  const batchSupported = typeof transport.readFilesBatch === 'function'

  if (batchSupported && toFetch.length > 0) {
    // ── 快路：批量（WSL）───────────────────────────────────────────────
    // 每批的路径数：argv 长度安全（一条 wsl.exe 命令行带上所有路径），
    // 且单批输出 = Σ(base64(文件)) 不至于撑爆 maxBuffer（64 MiB）。
    const BATCH_SIZE = 40
    const lanes = Math.max(1, Number(transport.readConcurrency) || 1)
    let cursor = 0
    const runBatch = async () => {
      while (true) {
        if (signal?.aborted === true) return
        const start = cursor
        cursor += BATCH_SIZE
        const batch = toFetch.slice(start, start + BATCH_SIZE)
        if (batch.length === 0) return

        let results
        try {
          results = await transport.readFilesBatch(
            batch.map((entry) => joinRemote(remoteRoot, entry.relPath)),
            { maxBytes: bounds.maxFileBytes, signal },
          )
        } catch (error) {
          if (isAbort(error, signal)) return
          // 整批失败 → **降级**：这一批退回逐个读（错误分类更细，语义不变）
          for (const entry of batch) {
            if (signal?.aborted === true) return
            try {
              const content = await transport.readFile(joinRemote(remoteRoot, entry.relPath), {
                maxBytes: bounds.maxFileBytes,
                signal,
                knownSize: entry.size,
              })
              await writeOne(entry, content)
            } catch (one) {
              if (isAbort(one, signal)) return
              noteError(entry, one)
            }
          }
          continue
        }

        for (const entry of batch) {
          const remotePath = joinRemote(remoteRoot, entry.relPath)
          const outcome = results.get(remotePath)
          if (outcome === undefined) {
            // 脚本没回这个路径（不该发生）：按单文件未知错误记下，不拖垮整棵树
            noteError(entry, new TransportError(
              TRANSPORT_ERROR.UNKNOWN,
              `批量读没有返回 "${entry.relPath}" 的结果`,
              { operation: 'readFilesBatch', target: remotePath },
            ))
            continue
          }
          if (outcome.ok !== true) {
            noteError(entry, outcome.error)
            continue
          }
          try {
            await writeOne(entry, outcome.data)
          } catch (error) {
            if (isAbort(error, signal)) return
            noteError(entry, error)
          }
        }
      }
    }
    const workers = []
    for (let i = 0; i < Math.min(lanes, Math.ceil(toFetch.length / BATCH_SIZE)); i += 1) {
      workers.push(runBatch())
    }
    await Promise.all(workers)
  } else if (toFetch.length > 0) {
    // ── 标准路：并发逐个（SSH / Docker / 批量能力探测失败时）──────────
    // 并发路数由 transport 自己声明（SSH 8；WSL 还有 #acquire 硬限流兜底）。
    const lanes = Math.max(1, Number(transport.readConcurrency) || 1)
    let cursor = 0
    const fetchOne = async () => {
      while (true) {
        if (signal?.aborted === true) return
        const index = cursor
        cursor += 1
        const entry = toFetch[index]
        if (entry === undefined) return
        try {
          const remotePath = joinRemote(remoteRoot, entry.relPath)
          const content = await transport.readFile(remotePath, {
            maxBytes: bounds.maxFileBytes,
            signal,
            // 遍历已经拿到 size —— 跳过实现里那次多余的 stat 往返（SSH）
            knownSize: entry.size,
          })
          await writeOne(entry, content)
        } catch (error) {
          if (isAbort(error, signal)) {
            // abort 是终态：整批立刻停，不再启动新任务
            return
          }
          noteError(entry, error)
        }
      }
    }
    const workers = []
    for (let i = 0; i < Math.min(lanes, toFetch.length); i += 1) workers.push(fetchOne())
    await Promise.all(workers)
  }

  // abort 是**终态**：用户点了取消，必须把中断信号一路传到连接层去清理锚点。
  // worker 里收到 abort 是「不再启动新任务」地退出，这里统一把它变成一次抛错 ——
  // 否则 mirror.init 会拿到一个「部分完成」的结果，connect 照常继续 → 取消形同虚设。
  if (signal?.aborted === true) {
    throw abortError('materializeTree', remoteRoot, new TransportError(TRANSPORT_ERROR.ABORTED, '已取消', { operation: 'materializeTree', target: remoteRoot }))
  }

  return {
    entries: walk.entries,
    written,
    unchanged,
    placeholders,
    skeleton,
    oversized,
    manifest: nextManifest,
    errors: [...walk.errors, ...errors],
    truncated: walk.truncated,
    reasons: walk.reasons,
    stats: {
      ...walk.stats,
      writtenFiles: written.length,
      unchangedFiles: unchanged.length,
      oversizedFiles: oversized.length,
    },
  }
}

/**
 * 内容指纹：`size:floor(mtime 秒)`。
 *
 * 为什么两个都要：只比 size 会漏掉「改了内容但字节数没变」的编辑；
 * 只比 mtime 会被「复制/解包后 mtime 相同」骗过。
 * mtime 向下取整到秒，是因为远程文件系统的 mtime 精度可能只有秒。
 *
 * @param {TreeEntry} entry
 * @returns {string}
 */
export function fingerprintOf(entry) {
  const size = entry.size ?? -1
  const seconds = entry.mtimeMs === undefined ? -1 : Math.floor(entry.mtimeMs / 1000)
  return `${size}:${seconds}`
}

/** 拼接远程路径，避免根尾斜杠产生 `//`。 */
function joinRemote(root, relPath) {
  const trimmed = String(root).replace(/\/+$/, '')
  return `${trimmed}/${relPath}`
}

/** 本地文件是否存在且是普通文件。 */
async function fileExists(path) {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/** 落盘前的围栏：目标是新建文件，`realpath` 可能还不存在，所以解析父目录。 */
async function assertWritable(resolvedAnchor, localPath, relPath) {
  const parent = dirname(localPath)
  let resolvedParent
  try {
    resolvedParent = await realpath(parent)
  } catch {
    // 父目录都不存在 → 后面的 writeFile 会报错，这里不掩盖
    return
  }
  assertInsideAnchor(resolvedAnchor, resolvedParent, { remotePath: relPath })
}

/** 判断一个错误是不是「取消」。 */
function isAbort(error, signal) {
  return signal?.aborted === true || error?.code === TRANSPORT_ERROR.ABORTED || error?.name === 'AbortError'
}

/** 把取消统一成 TransportError(ABORTED)。 */
function abortError(operation, target, cause) {
  return new TransportError(TRANSPORT_ERROR.ABORTED, '操作已被取消', { operation, target, cause })
}

/**
 * @typedef {object} TreeEntry
 * @property {string} relPath 相对远程根的 POSIX 路径
 * @property {'file'|'directory'|'other'} type
 * @property {number} depth
 * @property {number} [size]
 * @property {number} [mtimeMs]
 */

/**
 * @typedef {object} TreeWalkResult
 * @property {TreeEntry[]} entries
 * @property {{ path: string, code: string, message: string }[]} errors
 * @property {boolean} truncated
 * @property {string[]} reasons
 * @property {{ visited: number, directories: number, files: number, other: number, durationMs: number }} stats
 */

/**
 * @typedef {object} TreeMaterializeResult
 * @property {TreeEntry[]} entries
 * @property {TreeEntry[]} written
 * @property {TreeEntry[]} unchanged 指纹未变、跳过了远程读的文件
 * @property {TreeEntry[]} skeleton
 * @property {TreeEntry[]} oversized
 * @property {Record<string, string>} manifest 本次刷新后的内容指纹表
 * @property {{ path: string, code: string, message: string }[]} errors
 * @property {boolean} truncated
 * @property {string[]} reasons
 * @property {object} stats
 */

/**
 * 后台补拉的默认边界。
 *
 * 为什么和「打开工作区时的四重边界」分开：那一次要**快**（用户等着），
 * 这一次可以**慢**（连上之后在后台慢慢补）。所以给更大的单文件上限与时间预算，
 * 但**总量有硬上限** —— 不能因为用户连了个 8 GB 的工程就往本地灌 8 GB。
 */
export const DEFAULT_DEEPEN_BOUNDS = {
  /** 单文件上限：比首轮（256 KiB）大得多，覆盖绝大多数源码/配置/文档。 */
  maxFileBytes: 2 * 1024 * 1024,
  /** 一次补拉的**总字节上限**。到点就停（并如实报告停在哪）。 */
  maxTotalBytes: 64 * 1024 * 1024,
  /** 墙钟预算：后台任务也不能无限跑。 */
  maxDurationMs: 120_000,
  /** 最多访问多少条目。 */
  maxEntries: 50_000,
  /** 最大深度。 */
  maxDepth: 24,
}

/**
 * **后台补拉**：把「文本类 + 在上限内」的文件内容补进镜像。
 *
 * 为什么要这一步（2026-10-07 实测发现）：
 * 首轮遍历为了「连接要快」只拉 256 KiB 以内的文件 ——
 * 结果 300 KB 的 README、500 KB 的日志在界面的文件树里点开只有一句占位说明。
 * 而界面的读文件路径是**宿主独占**的（我们插不进手，实测 `provide` 会被拒），
 * 所以只能在**点开之前**先把内容补到本地 —— 这就是这一步。
 *
 * 三条约束：
 *   1. **只拉文本类**（按扩展名）：用户真正会「看」的文件基本都在白名单里；
 *      网格/数据库/压缩包不拉（它们本来也不适合在界面里读）
 *   2. **总量有硬上限**：到点就停，并如实报告 `stoppedByBudget`
 *   3. **失败不致命**：单个文件失败记下来继续；整体失败只记日志，不影响会话
 *
 * @param {object} options
 * @returns {Promise<object>} 补拉报告
 */
export async function deepenMirror(options) {
  const {
    transport,
    anchorPath,
    remoteRoot,
    ignore = BUILTIN_IGNORES,
    bounds = DEFAULT_DEEPEN_BOUNDS,
    textOnly = true,
    signal,
    onFileWritten,
    log,
  } = options

  await mkdir(anchorPath, { recursive: true })
  const resolvedAnchor = await realpath(anchorPath)

  const fetched = []
  const errors = []
  const skipped = { notText: 0, tooBig: 0, alreadyLocal: 0 }
  let bytes = 0
  let stoppedByBudget = false

  // 自己的取消器：总量到顶时用它**主动停下遍历**（而不是白跑完剩下的目录）
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  // ⚠️ **已经取消的信号要立刻中止** —— 只挂监听器是接不到「过去发生过的取消」的。
  // （实测踩到：传进来就 aborted 时，遍历照样从头跑到尾。）
  if (signal?.aborted === true) controller.abort()
  else signal?.addEventListener?.('abort', onOuterAbort, { once: true })

  const startedAt = Date.now()
  let walk
  try {
    walk = await walkRemoteTree({
      transport,
      remoteRoot,
      ignore,
      signal: controller.signal,
      bounds,
      onEntry: async (entry) => {
        if (entry.type !== 'file') return
        if (bytes >= bounds.maxTotalBytes) {
          stoppedByBudget = true
          controller.abort()
          return
        }
        if (textOnly && !isTextLike(entry.relPath)) {
          skipped.notText += 1
          return
        }
        const size = entry.size ?? 0
        if (size > bounds.maxFileBytes) {
          skipped.tooBig += 1
          return
        }
        const localPath = toAnchorPath(resolvedAnchor, entry.relPath)
        if ((await fileExists(localPath)) && !(await localIsPlaceholder(localPath))) {
          skipped.alreadyLocal += 1
          return
        }
        try {
          await mkdir(dirname(localPath), { recursive: true })
          const content = await transport.readFile(joinRemote(remoteRoot, entry.relPath), {
            maxBytes: bounds.maxFileBytes,
            signal: controller.signal,
          })
          await assertWritable(resolvedAnchor, localPath, entry.relPath)
          await writeFile(localPath, content)
          if (entry.mtimeMs !== undefined) {
            const seconds = entry.mtimeMs / 1000
            await utimes(localPath, seconds, seconds)
          }
          bytes += Buffer.byteLength(content)
          fetched.push(entry)
          if (onFileWritten !== undefined) await onFileWritten(entry)
        } catch (error) {
          if (isAbort(error, controller.signal)) {
            // 预算到顶是我们自己叫停的 —— 不是失败
            if (stoppedByBudget) return
            throw abortError('deepenMirror', entry.relPath, error)
          }
          errors.push({
            path: entry.relPath,
            code: error?.code ?? TRANSPORT_ERROR.UNKNOWN,
            message: String(error?.message ?? error),
          })
        }
      },
    })
  } catch (error) {
    // 预算到顶导致的 abort 当作正常结束；外部取消要如实抛出去
    if (!stoppedByBudget) throw error
    walk = { entries: [], errors: [], truncated: true, reasons: ['max-total-bytes'] }
  } finally {
    signal?.removeEventListener?.('abort', onOuterAbort)
  }

  const report = {
    fetched: fetched.length,
    bytes,
    skipped,
    stoppedByBudget,
    truncated: walk.truncated === true,
    reasons: walk.reasons ?? [],
    errors,
    durationMs: Date.now() - startedAt,
  }
  log?.(
    '[mirror] 后台补拉完成：新增 %d 个文件（%s），跳过（非文本 %d / 超限 %d / 已在本地 %d）%s',
    report.fetched,
    formatBytes(report.bytes),
    skipped.notText,
    skipped.tooBig,
    skipped.alreadyLocal,
    stoppedByBudget ? '，达到总量上限提前停止' : '',
  )
  return report
}
