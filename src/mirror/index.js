/**
 * 镜像层 —— 锚点目录 = 远程项目的「照片」（只给界面看）。
 *
 * 这个模块把前面四块拼起来，并负责两件只有它才能做的事：
 *   1. **锚点身份**：锚点目录名由「远程根 + 连接档案」稳定派生，且必须 realpath 后再用 ——
 *      宿主按会话 cwd 索引，存一个未归一化的路径会让后续所有查找对不上。
 *   2. **远程根变更时重建**：换了远程根还沿用同一个锚点，会把两个项目的照片混在一起，
 *      界面上出现根本不存在的文件。所以状态里记着 remoteRoot，不一致就整棵清掉重建。
 *
 * 三条铁律（贯穿整个镜像层）：
 *   - agent 从不读镜像 → 单向、懒加载、容忍过期，**不需要冲突检测**。
 *   - 镜像失败绝不影响 agent（照片层已保证；这里继续不抛）。
 *   - 遍历必须可取消、有墙钟预算、失败要上报（tree 层已保证）。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, realpath, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { BUILTIN_IGNORES, IgnoreRules } from './ignore.js'
import { ensureAnchorRepo, commitBaseline, readAnchorChanges, runGit } from './git.js'
import { materializeTree, DEFAULT_TREE_BOUNDS, deepenMirror, DEFAULT_DEEPEN_BOUNDS } from './tree.js'
import { writePhoto, writePhotos, removePhoto } from './photo.js'
import { assertInsideAnchor, normalizeRemoteRoot, toAnchorPath } from './paths.js'

/** 镜像自身状态所在目录（已写进锚点 .gitignore，不参与改动对比）。 */
export const STATE_DIR = '.dsh-multi-remote'

/** 状态文件名。 */
export const STATE_FILE = 'state.json'

/** 镜像状态格式版本。 */
const STATE_VERSION = 1

/**
 * 由一个「连接档案 + 远程根」派生稳定的锚点目录名。
 *
 * 为什么不用远程根的末段目录名：两台机器上都有 `project` 就会撞车。
 * 为什么用 sha256 而不是 32 位哈希：后者在几十个目标后就有可观碰撞概率。
 *
 * @param {string} profileId 连接档案标识（例如连接 id）
 * @param {string} remoteRoot 远程根（绝对 POSIX 路径）
 * @param {{ prefix?: string }} [options]
 * @returns {string} 形如 `mr-<profile>-<12 位十六进制>`
 */
export function anchorDirectoryName(profileId, remoteRoot, options = {}) {
  const root = normalizeRemoteRoot(remoteRoot)
  const profile = String(profileId ?? '').trim()
  if (profile === '') {
    throw new Error('anchorDirectoryName 需要非空的 profileId')
  }
  const digest = createHash('sha256').update(`${profile}\0${root}`, 'utf8').digest('hex').slice(0, 12)
  // 目录名里保留可读的档案名，便于人工排查；哈希负责区分同名的不同远程根。
  const safeProfile = profile.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 24)
  return `${options.prefix ?? 'mr'}-${safeProfile}-${digest}`
}

/** 镜像状态：记住「这个锚点是谁的照片」，用于检测远程根变更。 */
export class MirrorState {
  /**
   * @param {{ profileId: string, remoteRoot: string, refreshedAt?: string, stats?: object,
   *           manifest?: Record<string, string> }} init
   */
  constructor(init) {
    this.version = STATE_VERSION
    this.profileId = init.profileId
    this.remoteRoot = init.remoteRoot
    this.refreshedAt = init.refreshedAt ?? null
    this.stats = init.stats ?? null
    /**
     * 上次刷新时每个文件的内容指纹（`size:floor(mtime 秒)`）。
     * 刷新时指纹一致的文件不再拉内容 —— 只比 size 会漏掉「改了内容但字节数没变」的编辑。
     * @type {Record<string, string>}
     */
    this.manifest = init.manifest ?? {}
    /**
     * 上次**后台补拉**的报告（见 `tree.js` 的 `deepenMirror`）。
     * 记下来是为了能回答「为什么这个大文件在界面里只有占位」。
     * @type {object|null}
     */
    this.deepen = init.deepen ?? null
  }

  /** 转成可写 JSON 的普通对象。 */
  toJSON() {
    return {
      version: this.version,
      profileId: this.profileId,
      remoteRoot: this.remoteRoot,
      refreshedAt: this.refreshedAt,
      stats: this.stats,
      manifest: this.manifest,
      deepen: this.deepen,
    }
  }

  /**
   * 读状态。文件缺失或损坏时返回 `undefined` —— 调用方据此决定「需要重建」。
   * @param {string} anchorPath
   * @returns {Promise<MirrorState|undefined>}
   */
  static async read(anchorPath) {
    try {
      const text = await readFile(join(anchorPath, STATE_DIR, STATE_FILE), 'utf8')
      const parsed = JSON.parse(text)
      if (parsed?.version !== STATE_VERSION) return undefined
      return new MirrorState(parsed)
    } catch {
      return undefined
    }
  }

  /** @param {string} anchorPath */
  async write(anchorPath) {
    const dir = join(anchorPath, STATE_DIR)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, STATE_FILE), `${JSON.stringify(this.toJSON(), null, 2)}\n`, 'utf8')
  }
}

/**
 * 镜像。一个实例对应一个锚点目录。
 */
export class Mirror {
  /**
   * @param {object} options
   * @param {import('../transport/transport.js').Transport} options.transport
   * @param {string} options.anchorPath 锚点目录（本地绝对路径）
   * @param {string} options.remoteRoot 远程根（绝对 POSIX 路径）
   * @param {string} options.profileId 连接档案标识
   * @param {IgnoreRules} [options.ignore] 额外忽略规则（会与内置规则合并）
   * @param {typeof DEFAULT_TREE_BOUNDS} [options.bounds]
   * @param {(message: string, ...rest: unknown[]) => void} [options.log]
   */
  constructor(options) {
    this.transport = options.transport
    this.anchorPath = options.anchorPath
    this.remoteRoot = normalizeRemoteRoot(options.remoteRoot)
    this.profileId = options.profileId
    this.ignore = IgnoreRules.merge(BUILTIN_IGNORES, options.ignore ?? IgnoreRules.empty())
    this.bounds = options.bounds ?? DEFAULT_TREE_BOUNDS
    this.log = options.log

    /** @type {string|undefined} 已解析的锚点真实路径（围栏基准）。 */
    this.resolvedAnchor = undefined
    /** @type {MirrorState|undefined} */
    this.state = undefined
  }

  /**
   * 建立 / 刷新镜像基线。
   *
   * @param {{ signal?: AbortSignal, force?: boolean,
   *           onProgress?: (p: { phase: 'walk'|'fetch', visited?: number, done?: number, total?: number }) => void }} [options]
   *   `force` 为真时无条件整棵重建（手动刷新用）。
   * @returns {Promise<object>} 结果报告 —— **不抛异常**，失败在 `errors` 里
   */
  async init(options = {}) {
    const { signal, force = false, onProgress } = options
    const report = {
      anchorPath: this.anchorPath,
      remoteRoot: this.remoteRoot,
      rebuilt: false,
      gitCreated: false,
      gitCommitted: false,
      errors: [],
      truncated: false,
      reasons: [],
      stats: null,
    }

    try {
      await mkdir(this.anchorPath, { recursive: true })
      // **必须 realpath 后再用**：宿主按会话 cwd 索引，未归一化的路径会对不上；
      // 同时它也是围栏的基准。
      this.resolvedAnchor = await realpath(this.anchorPath)
      report.resolvedAnchor = this.resolvedAnchor

      const previous = await MirrorState.read(this.resolvedAnchor)
      const remoteChanged = previous !== undefined && previous.remoteRoot !== this.remoteRoot
      if (remoteChanged) {
        this.log?.('[mirror] 远程根变了（%s → %s），整棵重建', previous.remoteRoot, this.remoteRoot)
      }

      if (remoteChanged || force) {
        await this.wipeContent()
        report.rebuilt = true
      }

      const repo = await ensureAnchorRepo(this.resolvedAnchor, { log: this.log })
      report.gitCreated = repo.created

      const materialized = await materializeTree({
        transport: this.transport,
        anchorPath: this.resolvedAnchor,
        remoteRoot: this.remoteRoot,
        ignore: this.ignore,
        bounds: this.bounds,
        signal,
        onProgress,
        // 重建时不用旧指纹（文件已经清掉了，指纹无意义）
        manifest: report.rebuilt ? {} : (previous?.manifest ?? {}),
      })

      report.errors = materialized.errors
      report.truncated = materialized.truncated
      report.reasons = materialized.reasons
      report.stats = materialized.stats
      report.written = materialized.written.length
      report.unchanged = materialized.unchanged.length
      report.oversized = materialized.oversized.length

      // 基线提交：只在「仓库还没有任何提交」时做。
      // 之后镜像的更新**故意保持未提交**，那正是改动对比要展示的内容。
      const hasBaseline = await this.hasBaseline()
      if (!hasBaseline) {
        const committed = await commitBaseline(this.resolvedAnchor, 'chore(mirror): 远程项目镜像基线', { log: this.log })
        report.gitCommitted = committed.committed
      }

      this.state = new MirrorState({
        profileId: this.profileId,
        remoteRoot: this.remoteRoot,
        refreshedAt: new Date().toISOString(),
        stats: materialized.stats,
        manifest: materialized.manifest,
      })
      await this.state.write(this.resolvedAnchor)
    } catch (error) {
      // abort 是**终态**：用户点了取消，不能像「单个文件失败」那样吞进 errors ——
      // 必须抛出去让连接层 catch 到，进而 disconnect + 删掉半截锚点。
      if (signal?.aborted === true) throw error
      report.errors = [
        ...report.errors,
        { path: this.remoteRoot, code: error?.code ?? 'MIRROR_INIT_FAILED', message: String(error?.message ?? error) },
      ]
    }

    return report
  }

  /** 手动刷新：重新拉一遍目录结构（远程被他人改动时用）。 */
  async refresh(options = {}) {
    return this.init({ ...options, force: false })
  }

  /**
   * 照片层入口：agent 读了远程文件，顺手在镜像里留一份。
   *
   * @param {string} relPath 相对远程根的 POSIX 路径
   * @param {string|Buffer} content **复用 agent 本来就要读的那份内容**
   * @param {{ mtimeMs?: number, maxBytes?: number }} [options]
   */
  /**
   * **后台补拉**：把「文本类 + 在上限内」的文件内容补进镜像。
   *
   * 为什么需要（2026-10-07 用户实测）：界面的读文件路径是**宿主独占**的
   * （`workspaceFiles` → 宿主的沙箱 fs；我们插不进手 —— 实测 `provide` 会被拒），
   * 所以「点开文件时自动从远程拉」做不到。退而求其次：
   * **在点开之前**把用户真正会看的文件（源码/配置/文档）先补到本地。
   *
   * 这一步**不阻塞连接**：连上之后在后台跑，有总量与时间上限。
   *
   * @param {{ signal?: AbortSignal, bounds?: object, textOnly?: boolean }} [options]
   * @returns {Promise<object>} 补拉报告
   */
  async deepen(options = {}) {
    const resolvedAnchor = this.resolvedAnchor ?? (await realpath(this.anchorPath))
    this.resolvedAnchor = resolvedAnchor

    const report = await deepenMirror({
      transport: this.transport,
      anchorPath: resolvedAnchor,
      remoteRoot: this.remoteRoot,
      ignore: this.ignore,
      bounds: options.bounds ?? DEFAULT_DEEPEN_BOUNDS,
      textOnly: options.textOnly ?? true,
      signal: options.signal,
      log: this.log,
    })

    // 记进 state.json：将来能回答「这个文件为什么还是占位」
    try {
      const state = this.state ?? (await MirrorState.read(resolvedAnchor))
      if (state !== undefined) {
        state.deepen = { ...report, at: new Date().toISOString() }
        await state.write(resolvedAnchor)
      }
    } catch (error) {
      // 报告写不进去不影响补拉本身
      this.log?.('[mirror] 补拉报告没能写进 state.json：%s', String(error?.message ?? error))
    }
    return report
  }

  async photo(relPath, content, options = {}) {
    return writePhoto({
      anchorPath: this.resolvedAnchor ?? this.anchorPath,
      relPath,
      content,
      mtimeMs: options.mtimeMs,
      maxBytes: options.maxBytes ?? this.bounds.maxFileBytes,
      resolvedAnchor: this.resolvedAnchor,
    })
  }

  /** 批量照片。 */
  async photos(list, options = {}) {
    return writePhotos({
      anchorPath: this.resolvedAnchor ?? this.anchorPath,
      photos: list,
      maxBytes: options.maxBytes ?? this.bounds.maxFileBytes,
      resolvedAnchor: this.resolvedAnchor,
    })
  }

  /** agent 在远程删了文件，镜像里也删掉。 */
  async forget(relPath) {
    return removePhoto({
      anchorPath: this.resolvedAnchor ?? this.anchorPath,
      relPath,
      resolvedAnchor: this.resolvedAnchor,
    })
  }

  /** 读锚点当前的改动概览（与宿主改动对比同一读法，用于自检）。 */
  async changes() {
    return readAnchorChanges(this.resolvedAnchor ?? this.anchorPath)
  }

  /** 锚点内某个相对路径对应的本地绝对路径（界面 / 诊断用）。 */
  localPathOf(relPath) {
    return toAnchorPath(this.resolvedAnchor ?? this.anchorPath, relPath)
  }

  /** 仓库里是否已有提交（有基线）。 */
  async hasBaseline() {
    try {
      const result = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], {
        cwd: this.resolvedAnchor ?? this.anchorPath,
        allowExitCodes: [0, 1, 128],
      })
      return result.code === 0 && result.stdout.trim() !== ''
    } catch {
      return false
    }
  }

  /**
   * 清掉锚点里的**镜像内容**，保留 `.git` 与镜像状态目录。
   *
   * 刻意不用 `git clean`：那是破坏性命令，而且会连用户可能放进来的东西一起删。
   * 这里只删我们自己拉下来的东西。
   */
  async wipeContent() {
    const anchor = this.resolvedAnchor ?? this.anchorPath
    const keep = new Set(['.git', STATE_DIR])
    const entries = await readdir(anchor, { withFileTypes: true })
    for (const entry of entries) {
      if (keep.has(entry.name)) continue
      // 只删锚点内的路径：先解析再判定，防符号链接逃逸。
      const target = join(anchor, entry.name)
      try {
        const resolved = await realpath(target)
        assertInsideAnchor(anchor, resolved, { remotePath: entry.name })
      } catch (error) {
        if (error?.code === 'FS_SANDBOX_DENIED') {
          this.log?.('[mirror] 跳过越界的锚点条目：%s', entry.name)
          continue
        }
        // realpath 失败（悬空链接等）→ 直接按原路径删除
      }
      await rm(target, { recursive: true, force: true })
    }
  }
}
