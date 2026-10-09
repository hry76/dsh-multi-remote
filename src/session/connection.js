/**
 * 连接管理器 —— 把「连接档案」变成一个活的远程工作区。
 *
 * 一次 `connect(profile)` 做四件事（顺序不能变）：
 *   1. 建 transport 并**验证能连上**（连不上就没必要往下走）
 *   2. 注册 transport（隔离域内的 provider 靠它取远程）
 *   3. 建锚点镜像（格局层拉目录树 + git 基线）
 *   4. 注册预设并**回读诊断**（不可用就断开并抛错）
 *
 * 第 4 步的「不可用就抛错」是「绝不静默降级到本机」的实现点：
 * 预设没真的挂上却让用户建会话，agent 会在本机跑而界面显示已连上远程。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Mirror, anchorDirectoryName } from '../mirror/index.js'
import { buildPresetDefinition, presetIdFor } from './preset.js'
import { normalizeProfile, describeProfile, anchorPathOf } from './profile.js'
import { verifyRemoteRoot } from './verify-root.js'
import { registerTransport, unregisterTransport } from '../transport/registry.js'
import { SshTransport, KnownHosts, HOST_KEY_RESULT, fingerprintFromKnownHostsKey } from '../transport/ssh.js'
import { WslTransport } from '../transport/wsl.js'
import { DockerTransport } from '../transport/docker.js'

/** 默认锚点父目录：`~/.dsh-multi-remote/anchors`。 */
export function defaultAnchorParent() {
  return join(homedir(), '.dsh-multi-remote', 'anchors')
}

/**
 * 一个活的远程工作区。
 *
 * 生命周期：`connect()` → 用 → `disconnect()`。断开时按相反顺序清理：
 * 注销预设 → 注销 transport → 断开连接。镜像与锚点目录**保留**，
 * 这样重连后界面立刻有内容（镜像容忍过期）。
 */
export class RemoteWorkspace {
  /**
   * @param {object} options
   * @param {object} options.profile 见 `normalizeProfile`
   * @param {object} options.agentPresets 宿主服务
   * @param {(message: string, ...rest: unknown[]) => void} [options.log]
   * @param {(profile: object, hooks: object) => import('../transport/transport.js').Transport} [options.createTransport]
   *   建 transport 的工厂。默认建 SSH —— 注入点存在的理由是让「连接编排」
   *   可以脱离真网络被单测（编排逻辑本身最容易出错）。
   */
  constructor(options) {
    this.profile = options.profile
    this.agentPresets = options.agentPresets
    this.log = options.log
    this.createTransport = options.createTransport ?? defaultCreateTransport
    /** @type {import('../transport/transport.js').Transport|undefined} */
    this.transport = undefined
    /** @type {Mirror|undefined} */
    this.mirror = undefined
    /** 后台补拉的边界（见 mirror/tree.js 的 DEFAULT_DEEPEN_BOUNDS）。 */
    this.deepenBounds = options.deepenBounds
    /** `false` 可完全关掉后台补拉。 */
    this.deepenEnabled = options.deepenEnabled !== false
    /** 补拉的取消器（断开连接时中止，别让后台任务挂在已断的连接上）。 */
    this.deepenController = undefined
    /** @type {object|undefined} 最近一次补拉报告 */
    this.deepenReport = undefined
    /** @type {string|undefined} 锚点目录绝对路径 */
    this.anchorPath = undefined
    /** @type {string|undefined} */
    this.presetId = undefined
    /** @type {object|undefined} 预设诊断结果 */
    this.presetDiagnostic = undefined
    this.connected = false
    /**
     * 已知主机记录（TOFU）。M1 只存内存 —— 持久化与凭据保护是 M2 的事。
     * 可以由调用方注入（例如从用户已有的 `~/.ssh/known_hosts` 导入信任，
     * 避免对已知主机重复确认）。
     * @type {KnownHosts}
     */
    this.knownHosts = new KnownHosts(options.knownHosts ?? {})
  }

  /** 由档案派生出的锚点目录名（与预设 id 用同一套输入，便于对照）。 */
  get anchorDirectoryName() {
    return anchorDirectoryName(this.profile.id, this.profile.remoteRoot)
  }

  /** 给界面/模型看的安全描述。 */
  describe() {
    return {
      ...describeProfile(this.profile),
      connected: this.connected,
      anchorPath: this.anchorPath ?? null,
      presetId: this.presetId ?? null,
      presetUsable: this.presetDiagnostic?.usable ?? null,
    }
  }

  /**
   * 建立连接并准备好远程工作区。
   *
   * @param {object} options
   * @param {import('../session/preset.js').PresetRegistry} options.presetRegistry
   * @param {(info: object) => boolean|void} [options.confirmHostKey]
   *   host key 确认回调：**首次见到**时被调用。抛错或返回 false 即拒绝。
   *   给了回调才允许 TOFU；没给就只信任已记录的指纹。
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<object>} 报告（含镜像统计与预设诊断）
   */
  async connect(options = {}) {
    if (this.connected) throw new Error(`连接档案 ${this.profile.id} 已经连上了`)

    const profile = this.profile
    const report = { profileId: profile.id, steps: {} }

    // ── 1. transport + 连通性 ────────────────────────────────────────────
    const transport = this.createTransport(profile, {
      knownHosts: this.knownHosts,
      confirmHostKey: options.confirmHostKey,
    })

    await transport.connect()
    this.transport = transport
    report.steps.connect = { ok: true, fingerprint: transport.observedFingerprint ?? null }

    // ── 1.5 校验远程项目根**存在**（真机事故换来的）──────────────────────
    // 用户把根填成一个不存在的路径 → 连接「成功」→ 之后每条命令都先 cd 到
    // 不存在的目录 → 失败，而报错只是一句含糊的 cd 错误。
    // 路径是用户在界面上填的，就该**当场**验证，并把「同名目录在哪」直接告诉他。
    const verified = await verifyRemoteRoot(transport, profile.remoteRoot, { signal: options.signal })
    report.steps.verifyRoot = { ok: true, candidates: verified.candidates }

    // ── 2. 注册 transport（隔离域内的 provider 靠它取远程） ───────────────
    // 若同一 id 已注册，说明有泄漏的旧连接；先清掉再注册，避免静默覆盖。
    unregisterTransport(profile.id)
    registerTransport(profile.id, transport)

    try {
      // ── 3. 锚点镜像 ────────────────────────────────────────────────────
      this.anchorPath = anchorPathOf(profile, this.anchorDirectoryName)
      const mirror = new Mirror({
        transport,
        anchorPath: this.anchorPath,
        remoteRoot: profile.remoteRoot,
        profileId: profile.id,
        log: this.log,
      })
      const mirrorReport = await mirror.init({ signal: options.signal })
      this.mirror = mirror
      report.steps.mirror = {
        anchorPath: mirrorReport.resolvedAnchor ?? this.anchorPath,
        written: mirrorReport.written ?? 0,
        unchanged: mirrorReport.unchanged ?? 0,
        oversized: mirrorReport.oversized ?? 0,
        truncated: mirrorReport.truncated,
        reasons: mirrorReport.reasons,
        errors: mirrorReport.errors,
        gitCreated: mirrorReport.gitCreated,
        gitCommitted: mirrorReport.gitCommitted,
      }

      // ── 4. 预设注册 + 回读诊断 ─────────────────────────────────────────
      this.presetId = presetIdFor(profile.id, profile.remoteRoot)
      // 展示用的「这是哪台机器」：SSH 给 host，WSL 给发行版，Docker 给容器名
      const where = profile.kind === 'wsl'
        ? `WSL ${profile.distro}`
        : profile.kind === 'docker'
          ? `容器 ${profile.container}`
          : profile.host
      const definition = buildPresetDefinition({
        profileId: profile.id,
        remoteRoot: profile.remoteRoot,
        name: `远程：${profile.label}（${where}）`,
        description: `文件与命令在 ${where}:${profile.remoteRoot} 执行`,
        // 锚点目录：会话 cwd 就是它，域内 shell 靠它把本机路径翻译成远程路径
        anchorPath: this.anchorPath,
      })
      const diagnostic = await options.presetRegistry.register(definition)
      this.presetDiagnostic = diagnostic
      report.steps.preset = {
        id: diagnostic.id,
        present: diagnostic.present,
        usable: diagnostic.usable,
        broken: diagnostic.broken ?? null,
      }

      // **绝不静默降级**：预设不可用就断开，而不是让用户建一个「假远程」会话。
      if (!diagnostic.usable) {
        throw new Error(
          `预设 ${diagnostic.id} 激活失败：${diagnostic.broken ?? '未知原因'}` +
          ' —— 拒绝让会话在本机降级运行',
        )
      }

      this.connected = true
      report.ok = true

      // ── 5. **后台补拉**（不阻塞连接）────────────────────────────────────
      // 首轮遍历为了「连接要快」只拉 256 KiB 以内的文件；这里在后台把
      // 「文本类 + 上限内」的文件补到本地 —— 否则界面的文件树点开大一点的
      // README/日志只有一句占位说明（界面的读文件路径是宿主独占的，插不进手）。
      // 失败/超时都不影响会话：只记日志。
      this.#startDeepen(mirror)

      return report
    } catch (error) {
      // 任何一步失败都要把已建立的资源收干净，不留半截状态
      await this.disconnect().catch(() => {})
      report.ok = false
      report.error = String(error?.message ?? error)
      report.code = error?.code ?? null
      throw Object.assign(new Error(report.error), { report, code: report.code })
    }
  }

  /**
   * 启动后台补拉（**不 await**）。
   *
   * 三条约束：不阻塞连接、失败只记日志、断开时中止。
   */
  #startDeepen(mirror) {
    if (this.deepenEnabled === false) return
    const controller = new AbortController()
    this.deepenController = controller
    this.deepenPromise = mirror
      .deepen({ signal: controller.signal, bounds: this.deepenBounds })
      .then((report) => {
        this.deepenReport = report
        this.log?.(
          '[session] 后台补拉完成：%d 个文件（%d KB），跳过（非文本 %d / 超限 %d / 已在本地 %d）',
          report.fetched,
          Math.round(report.bytes / 1024),
          report.skipped?.notText ?? 0,
          report.skipped?.tooBig ?? 0,
          report.skipped?.alreadyLocal ?? 0,
        )
        return report
      })
      .catch((error) => {
        // 取消（断开连接）是正常终态；其他失败也只是补拉失败，**不影响会话**
        this.log?.('[session] 后台补拉结束：%s', String(error?.message ?? error))
        return undefined
      })
  }
  /** 手动刷新镜像（远程被他人改动时用）。 */
  async refresh(options = {}) {
    if (this.mirror === undefined) throw new Error('尚未建立镜像')
    return this.mirror.refresh(options)
  }

  /**
   * 断开并清理。
   *
   * 顺序与 connect 相反。**幂等**：重复调用不抛错。
   * 刻意**不删锚点目录** —— 重连后界面能立刻有内容，且删目录是破坏性操作。
   *
   * 注意：预设的注销由 `ConnectionManager.disconnect()` 负责（它持有 registry）。
   * 单独调用本方法只会断开底层连接。
   */
  async disconnect() {
    this.connected = false

    // 先停后台补拉：连接都要断了，继续读远程只会产生一串无意义的失败
    this.deepenController?.abort()

    // 1. 注销 transport（隔离域内的 provider 立刻拿不到远程 → 明确报错，不会回退本机）
    unregisterTransport(this.profile.id)

    // 2. 断开连接
    const transport = this.transport
    this.transport = undefined
    if (transport !== undefined) {
      await transport.disconnect().catch(() => {})
    }
  }
}

/**
 * 连接管理器：持有多个远程工作区，按档案 id 索引。
 */
export class ConnectionManager {
  /**
   * @param {object} options
   * @param {object} options.agentPresets
   * @param {import('./preset.js').PresetRegistry} options.presetRegistry
   * @param {(message: string, ...rest: unknown[]) => void} [options.log]
   * @param {Function} [options.createTransport] 建 transport 的工厂（测试注入用）
   */
  constructor(options) {
    this.agentPresets = options.agentPresets
    this.presetRegistry = options.presetRegistry
    this.log = options.log
    this.createTransport = options.createTransport
    /** 后台补拉的边界与开关（插件配置透传）。 */
    this.deepenBounds = options.deepenBounds
    this.deepenEnabled = options.deepenEnabled !== false
    /** @type {Map<string, RemoteWorkspace>} */
    this.workspaces = new Map()
  }

  /**
   * 连接一个档案。
   * @param {object} input 原始档案（会被校验）
   * @param {object} [options]
   * @param {object} [options.knownHosts] 已知主机记录（`host:port` → sha256 指纹）
   * @param {(info: object) => boolean|void} [options.confirmHostKey] 首次连接的确认回调
   * @returns {Promise<RemoteWorkspace>}
   */
  async connect(input, options = {}) {
    const profile = normalizeProfile(input)
    if (this.workspaces.has(profile.id)) {
      throw new Error(`档案 ${profile.id} 已经连接（重复连接会让命令可能发往错误的机器）`)
    }
    const workspace = new RemoteWorkspace({
      profile,
      agentPresets: this.agentPresets,
      log: this.log,
      createTransport: this.createTransport,
      knownHosts: options.knownHosts,
      deepenBounds: this.deepenBounds,
      deepenEnabled: this.deepenEnabled,
    })
    // 先放进表里，这样中途失败时 disconnect 能把它收干净
    this.workspaces.set(profile.id, workspace)
    try {
      await workspace.connect({ ...options, presetRegistry: this.presetRegistry })
      return workspace
    } catch (error) {
      this.workspaces.delete(profile.id)
      throw error
    }
  }

  /** 取一个已连接的工作区。 */
  get(profileId) {
    return this.workspaces.get(String(profileId ?? '').trim())
  }

  /**
   * 按锚点目录找所属工作区 —— **会话绑定的入口**。
   *
   * 会话的 `header.cwd` 就是锚点目录，所以「这个会话属于哪台机器」
   * 完全由 cwd 决定。找不到就返回 undefined，调用方必须明确报错，绝不回退。
   *
   * @param {string} cwd
   * @returns {RemoteWorkspace|undefined}
   */
  findByAnchor(cwd) {
    const target = normalizeForCompare(cwd)
    if (target === '') return undefined
    for (const workspace of this.workspaces.values()) {
      if (workspace.anchorPath === undefined) continue
      if (normalizeForCompare(workspace.anchorPath) === target) return workspace
    }
    return undefined
  }

  /** 断开一个档案（幂等）。 */
  async disconnect(profileId) {
    const workspace = this.workspaces.get(String(profileId ?? '').trim())
    if (workspace === undefined) return false
    this.workspaces.delete(workspace.profile.id)
    // 预设要先注销：否则重新连接会撞 Duplicate agent preset
    if (workspace.presetId !== undefined) {
      await this.presetRegistry.unregister(workspace.presetId).catch(() => {})
    }
    await workspace.disconnect()
    return true
  }

  /** 断开全部（插件卸载时调用）。 */
  async disconnectAll() {
    const ids = [...this.workspaces.keys()]
    const results = await Promise.allSettled(ids.map((id) => this.disconnect(id)))
    return { removed: ids.length, failed: results.filter((result) => result.status === 'rejected').length }
  }

  /** 当前连接概览（给工具输出 / 诊断用，**不含凭据**）。 */
  list() {
    return [...this.workspaces.values()].map((workspace) => workspace.describe())
  }
}

/** 路径比较用的归一化：Windows 上大小写不敏感。 */
function normalizeForCompare(input) {
  const value = String(input ?? '').trim().replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/**
 * 默认的 transport 工厂：按档案的 `kind` 建对应的后端。
 *
 * - `ssh`：host key 语义是「一致直接放行；**首次见到交给 `confirmHostKey` 决定**（TOFU）；
 *   不一致由 SshTransport 自己拒绝」。
 * - `wsl`：本机进程，**没有凭据也没有 host key**，只要发行版名。
 */
function defaultCreateTransport(profile, hooks) {
  if (profile.kind === 'wsl') {
    return new WslTransport({
      distro: profile.distro,
      username: profile.wslUser,
      log: hooks.log,
    })
  }

  if (profile.kind === 'docker') {
    return new DockerTransport({
      container: profile.container,
      pipe: profile.dockerPipe,
      log: hooks.log,
    })
  }

  return new SshTransport({
    host: profile.host,
    port: profile.port,
    username: profile.username,
    privateKeyPath: profile.privateKeyPath,
    privateKey: profile.privateKey,
    passphrase: profile.passphrase,
    password: profile.password,
    agent: profile.agent,
    tryKeyboard: profile.tryKeyboard,
    knownHosts: hooks.knownHosts,
    onHostKey: (info) => {
      if (info.result === HOST_KEY_RESULT.MATCH) return
      const accepted = hooks.confirmHostKey?.(info)
      if (accepted === false) {
        throw new Error(`用户拒绝了主机密钥（${info.fingerprint}）`)
      }
    },
  })
}

export { fingerprintFromKnownHostsKey, KnownHosts, HOST_KEY_RESULT, defaultCreateTransport }
