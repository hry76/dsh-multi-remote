/**
 * dsh-multi-remote — 宿主半边
 *
 * 这个插件让 agent 的**文件读写改与命令执行**落在远程机器上，而**大脑留在本地**：
 * 模型调用在这台装了 DSH 的机器上，文件与命令在目标环境里。
 *
 * ## 架构（三块，各司其职）
 *
 * ```
 *   Transport（ssh / 将来 wsl / docker）
 *        ↑ 隔离域内的 provider 只认这个接口
 *   ┌────┴─────────────────────────┐
 *   │ 预设隔离域                    │  fs    → 远程文件
 *   │ （每个远程工作区一份预设）      │  shell → 远程命令
 *   └──────────────────────────────┘
 *        ↑ 会话绑定（抓住「刚创建、第一轮还没开始」的窗口）
 *
 *   锚点目录 = 远程项目的**只读镜像**（只给界面看，agent 从不读它）
 * ```
 *
 * ## 三条不可违反的约束
 *
 * 1. **预设必须用运行时 `agentPresets.register()`**。写 `.agent-presets/` 的老方式
 *    在当前 DSH 已死 → 会话会**静默留在本机跑**。
 * 2. **注册/激活失败只写一条 warn、不抛错** → 必须自己回读诊断
 *    （`compositionInventory().broken`），否则会静默降级。
 * 3. **绝不静默降级到本机**。预设没挂上就拒绝这一步，而不是让命令落在本机。
 *
 * 入口契约：`export const name` / `export const inject` / `export function apply(ctx, config)`。
 *
 * 注意：`@deepseek-ai/dsh-tools` 必须同时声明在 package.json 的 peerDependencies 里。
 * 宿主按**清单声明的依赖**做裸包名路由；只 import 不声明会以 ERR_MODULE_NOT_FOUND 失败。
 */
import { readFileSync } from 'node:fs'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { PresetRegistry } from './session/preset.js'
import { ConnectionManager, defaultAnchorParent } from './session/connection.js'
import { SessionBinder } from './session/binder.js'
import { MachineRegistry } from './session/machines.js'
import { DEFAULT_DEEPEN_BOUNDS } from './mirror/tree.js'
import { normalizeProfile, ProfileError, saveProfile, loadProfile, listProfiles, deleteProfile } from './session/profile.js'
import { registeredProfileIds } from './transport/registry.js'
import { probeBackends, listTargets } from './diagnostics.js'
import { fence, checkRequestFence } from './http/fence.js'
import {
  ROUTE_UI_OPTIONS,
  ROUTE_UI_PICK,
  ROUTE_UI_CONNECT,
  ROUTE_UI_CLIENT_REPORT,
  ROUTE_UI_MACHINE_CONNECT,
  ROUTE_UI_MACHINE_LIST,
  ROUTE_UI_MACHINE_OPEN,
  ROUTE_UI_MACHINE_DISCONNECT,
  ROUTE_UI_OPEN_WORKSPACE,
  ROUTE_UI_SETTINGS,
  workspaceTitle,
  readJsonBody,
  normalizeConnectRequest,
  normalizeClientReport,
  normalizeSettingsPatch,
  SETTINGS_LIMITS,
  deriveConnectId,
  describeProfiles,
  describeConnected,
} from './http/ui-routes.js'
import { AuditLog } from './audit.js'

/** 插件身份。必须与 cordis.patch.yml 里的包名、package.json 的 name 一致。 */
export const name = '@jk-uzi/dsh-multi-remote'

/**
 * 依赖的宿主服务。缺任何一个都不该挂载：
 *   agentPresets —— 注册远程预设（核心机制，缺了整个插件就没意义）
 *   tools        —— 注册模型工具
 *   webServer    —— 注册自检路由
 */
export const inject = ['agentPresets', 'tools', 'webServer']

/** 路由路径必须全局唯一，否则插件树会因「duplicate route」启动失败。 */
const ROUTE_PING = '/multi-remote/ping'
const ROUTE_SELFCHECK = '/multi-remote/selfcheck'
const ROUTE_WORKSPACES = '/multi-remote/workspaces'
const ROUTE_AUDIT = '/multi-remote/audit'

/** 本插件注册的全部工具名（自检路由与工具注册共用一份，避免两处漂移）。 */
const TOOL_NAMES = ['remote_connect', 'remote_profiles', 'remote_list', 'remote_disconnect', 'remote_refresh']

/** 插件挂载时刻，用于 /ping 报告 uptime。 */
const startedAt = Date.now()

/** 版本号从 package.json 读；读不到就退回占位值，绝不因此让插件挂载失败。 */
let VERSION = '0.0.0'
try {
  VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? VERSION
} catch {
  // 打包/内联场景下可能读不到，保持占位值即可。
}

/** 统一的 JSON 响应。 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body, null, 2))
}

/** 工具输出的统一 schema / render（四个工具形状一致，抽出来避免抄四遍）。 */
function textOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean', required: true },
        message: { type: 'string', required: true },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.message }],
  }
}

/** 把一份档案/工作区描述渲染成一行「连到哪儿」——三种后端的字段不同。 */
function describeTarget(entry) {
  if (entry.kind === 'wsl') return `WSL ${entry.distro ?? '?'}`
  if (entry.kind === 'docker') return `容器 ${entry.container ?? '?'}`
  return `${entry.username ?? '?'}@${entry.host ?? '?'}:${entry.port ?? '?'}`
}

export function apply(ctx, config = {}) {
  const log = ctx.logger
  log?.info?.('[dsh-multi-remote] apply() 开始（版本 %s）', VERSION)
  /**
   * 连接档案的存储目录。
   *
   * 只存**非敏感字段**（见 session/profile.js 的 NON_PERSISTED_KEYS）：
   * 主机、账号、路径、私钥**路径**落盘，口令与私钥内容永不落盘。
   * 这样「重连」不用重敲，而凭据仍然每次现给。
   */
  const profileStoreDir = config.profileStoreDir
    ?? (typeof ctx.dshHomePath === 'function' ? ctx.dshHomePath('.dsh-multi-remote', 'profiles') : undefined)

  /**
   * 后端可用性探测。
   *
   * 可通过 `config.probeBackends` 注入 —— 测试里不该去连真 Docker / 真 WSL，
   * 否则单元测试会依赖外部环境（慢、且在有/没有 Docker 的机器上结果不同）。
   */
  const probe = config.probeBackends ?? probeBackends

  /**
   * 「列出可以连的目标」（WSL 发行版 / Docker 容器），给界面用。
   *
   * 与 `probe` 一样可注入 —— 测试不该去连真 Docker / 真 WSL，
   * 否则单测会依赖外部环境（慢，而且有没有 Docker 的机器上结果不同）。
   */
  const listTargetsFn = config.listTargets ?? listTargets

  /**
   * 审计日志：记**面向操作**的轨迹（连过谁、什么时候、成没成、哪条命令在哪台机器上）。
   *
   * 有界（默认 500 条）、绝不落凭据、绝不抛错 —— 见 src/audit.js 的三条约束。
   * `config.auditCapacity` 可调；测试可注入自己的实例。
   */
  const audit = config.auditLog ?? new AuditLog({ capacity: config.auditCapacity })

  // ── 组装三块 ────────────────────────────────────────────────────────────
  const presetRegistry = new PresetRegistry({
    agentPresets: ctx.agentPresets,
    log: (...args) => log?.warn?.(...args),
  })
  // 后台补拉：连上之后把「文本类 + 上限内」的文件补到本地，
  // 让界面里点开就能看（否则只有一句占位说明）。
  // `config.mirrorDeepen = { enabled, maxFileBytes, maxTotalBytes, maxDurationMs }`
  const deepenCfg = config.mirrorDeepen ?? {}
  const deepenBounds = deepenCfg.bounds ?? {
    ...DEFAULT_DEEPEN_BOUNDS,
    ...Number.isInteger(deepenCfg.maxFileBytes) ? { maxFileBytes: deepenCfg.maxFileBytes } : {},
    ...Number.isInteger(deepenCfg.maxTotalBytes) ? { maxTotalBytes: deepenCfg.maxTotalBytes } : {},
    ...Number.isInteger(deepenCfg.maxDurationMs) ? { maxDurationMs: deepenCfg.maxDurationMs } : {},
  }

  const connections = new ConnectionManager({
    agentPresets: ctx.agentPresets,
    presetRegistry,
    deepenEnabled: deepenCfg.enabled !== false,
    deepenBounds,
    // 连接生命周期进审计：这是用户最常需要回溯的东西
    log: (...args) => {
      log?.info?.(...args)
      audit.record('connection', { message: args.map((arg) => String(arg)).join(' ') })
    },
    // 测试注入用（与 ConnectionManager 自己的接缝一致）
    ...config.createTransport === undefined ? {} : { createTransport: config.createTransport },
  })

  // 已连接但**还没选项目**的机器（「先连机器、再选文件夹」流程的第一步）。
  // 浏览用的连接是短命的：选好目录后由 connections 自己再建一条完整连接。
  const machines = new MachineRegistry({
    log: (...args) => log?.info?.(...args),
    ...config.createTransport === undefined ? {} : { createTransport: config.createTransport },
  })
  const binder = new SessionBinder({
    connections,
    presetRegistry,
    agentPresets: ctx.agentPresets,
    log: (...args) => log?.info?.(...args),  })

  // 会话绑定钩子：抓住「刚创建、第一轮还没开始」的窗口
  ctx.effect(() => binder.install(ctx), `${name}: 会话绑定钩子`)

  // 插件卸载：断开全部连接并注销全部预设，保证可重复挂载
  ctx.effect(() => () => {
    // 浏览用的机器连接也要一起收干净 —— 否则卸载后 SSH 会话还挂着
    return machines.disconnectAll()
      .then(() => connections.disconnectAll())
      .then(() => presetRegistry.unregisterAll())
  }, `${name}: 清理连接、机器与预设`)

  // ── 工具 ────────────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'remote_connect',
    description:
      '连接一台远程机器，把它变成一个可用的远程工作区：' +
      '在本地建立该项目的只读镜像（界面靠它显示文件树与改动），' +
      '并注册一个「文件与命令都在远程执行」的会话预设。\n\n' +
      '支持三种后端：\n' +
      "  - kind='ssh'（默认）：连 SSH 服务器，需要 host / username / 认证方式\n" +
      "  - kind='wsl'：连本机 WSL 发行版，只需要 distro，**不需要任何凭据**\n" +
      "  - kind='docker'：连**已在运行**的容器，只需要 container，**不需要任何凭据**\n\n" +
      '连接成功后会返回 anchorPath。**用户流程有硬约束**：' +
      '必须先把这个 anchorPath 作为工作区打开、再新建会话，远程预设才会生效' +
      '（预设只能在会话第一轮开始之前选定）。',
    parameters: {
      id: { type: 'string', required: true, description: '连接档案标识（唯一，不能含点号）' },
      kind: { type: 'string', description: "后端类型：'ssh'（默认）/ 'wsl' / 'docker'" },
      remoteRoot: { type: 'string', required: true, description: '远程项目根，绝对 POSIX 路径（如 /home/user/proj）' },
      anchorParent: { type: 'string', description: `本地锚点目录的父目录（默认 ${defaultAnchorParent()}）` },
      label: { type: 'string', description: '显示名' },
      distro: { type: 'string', description: "WSL 发行版名（kind='wsl' 时必填，如 Ubuntu-24.04）" },
      wslUser: { type: 'string', description: 'WSL 里以哪个 Linux 用户执行（可选）' },
      container: { type: 'string', description: "Docker 容器名或 id（kind='docker' 时必填，必须已在运行）" },
      dockerPipe: { type: 'string', description: 'Docker 命名管道（可选，默认自动探测）' },
      host: { type: 'string', description: "SSH 主机（kind='ssh' 时必填）" },
      port: { type: 'number', description: 'SSH 端口，默认 22' },
      username: { type: 'string', description: "SSH 登录账号（kind='ssh' 时必填）" },
      privateKeyPath: { type: 'string', description: '私钥文件路径' },
    },
    output: textOutput(),
    async execute(args) {
      try {
        // 只给 id 时，尝试用已保存的档案补齐（口令永远不在档案里，要现给）
        let input = args
        if (profileStoreDir !== undefined) {
          const saved = await loadProfile(profileStoreDir, args.id)
          if (saved !== undefined) {
            input = { ...saved, ...args }
            // 未显式提供的敏感字段一律清掉，绝不用档案里可能过期的值
            for (const key of ['password', 'privateKey', 'passphrase', 'agent']) {
              if (args[key] === undefined) delete input[key]
            }
          }
        }

        const workspace = await connections.connect({
          ...input,
          anchorParent: input.anchorParent ?? defaultAnchorParent(),
        })
        const described = workspace.describe()

        // 连上了才存档案：存失败不影响本次连接，但要如实告知
        let persistNote = ''
        if (profileStoreDir !== undefined) {
          try {
            await saveProfile(profileStoreDir, workspace.profile)
          } catch (error) {
            persistNote = `\n（注意：档案没能保存，下次要重新输入：${error?.message ?? error}）`
          }
        }

        const target = described.kind === 'wsl'
          ? `WSL ${described.distro}`
          : described.kind === 'docker'
            ? `容器 ${described.container}`
            : `${described.username}@${described.host}:${described.port}`

        audit.record('connect-ok', {
          profileId: described.id,
          kind: described.kind,
          target,
          remoteRoot: described.remoteRoot,
          anchorPath: described.anchorPath,
          presetId: described.presetId,
        })

        return {
          ok: true,
          message:
            `已连接 ${described.label}（${target}）。\n` +
            `远程项目根：${described.remoteRoot}\n` +
            `本地镜像锚点：${described.anchorPath}\n` +
            `预设：${described.presetId}（可用）${persistNote}\n\n` +
            '下一步：把上面的「本地镜像锚点」作为工作区打开，然后新建会话 —— ' +
            '这样会话的文件读写与命令执行才会落在远程。',
          workspace: described,
        }
      } catch (error) {
        // 失败的连接同样要进审计 —— 排查「为什么连不上」时，这条是最有用的
        audit.record('connect-failed', {
          profileId: typeof args.id === 'string' ? args.id : null,
          kind: typeof args.kind === 'string' ? args.kind : 'ssh',
          code: error?.code ?? null,
          // 错误信息里可能夹带凭据（例如服务端回显），`redact` 会抹掉
          message: String(error?.message ?? error),
        })
        return {
          ok: false,
          message:
            `连接失败：${error?.message ?? error}\n` +
            '（为避免文件与命令落在本机，这个连接没有建立。）',
          code: error?.code ?? null,
        }
      }
    },
  })), `${name}: remote_connect`)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'remote_profiles',
    description:
      '管理已保存的 SSH 连接档案。档案只存主机、账号、路径与私钥**路径**；' +
      '口令与私钥内容永不落盘，每次连接现给。',
    parameters: {
      action: { type: 'string', required: true, description: "'list' 或 'delete'" },
      id: { type: 'string', description: "action='delete' 时要删的档案 id" },
    },
    output: textOutput(),
    async execute(args) {
      if (profileStoreDir === undefined) {
        return { ok: false, message: '当前环境无法确定档案存储目录，档案功能不可用。' }
      }
      if (args.action === 'delete') {
        if (args.id === undefined) return { ok: false, message: "action='delete' 需要提供 id。" }
        const removed = await deleteProfile(profileStoreDir, args.id)
        return removed
          ? { ok: true, message: `已删除档案 ${args.id}。` }
          : { ok: false, message: `没有名为 ${args.id} 的档案。` }
      }
      if (args.action !== 'list') {
        return { ok: false, message: `不支持的 action：${args.action}（只支持 list / delete）` }
      }
      const saved = await listProfiles(profileStoreDir)
      if (saved.length === 0) return { ok: true, message: '还没有保存过任何连接档案。', profiles: [] }
      // ⚠️ **机器级档案**（`machine: true`，界面里「用过的连接」存的就是它）**没有项目根**
      // —— 项目根是第二步（选文件夹）才有的。直接拼 `${entry.remoteRoot}` 会打印出
      // `undefined`，那是谎报（看起来像「路径叫 undefined」）。
      const lines = saved.map((entry) => {
        const where = entry.remoteRoot === undefined || entry.remoteRoot === ''
          ? `${describeTarget(entry)}（还没选项目目录）`
          : `${describeTarget(entry)} → ${entry.remoteRoot}`
        return `- ${entry.id}：${where}`
      })
      return {
        ok: true,
        message: `已保存的连接档案（${saved.length} 个）：\n${lines.join('\n')}\n\n用 remote_connect 只传 id 即可重连（口令要现给）。`,
        profiles: saved,
      }
    },
  })), `${name}: remote_profiles`)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'remote_list',
    description: '列出当前已连接的远程工作区及其本地镜像锚点。',
    parameters: {},
    output: textOutput(),
    async execute() {
      const list = connections.list()
      if (list.length === 0) {
        return { ok: true, message: '当前没有已连接的远程工作区。', workspaces: [] }
      }
      const lines = list.map((entry) =>
        `- ${entry.id}：${describeTarget(entry)} → ${entry.remoteRoot}\n` +
        `  锚点：${entry.anchorPath}\n  预设：${entry.presetId}（${entry.presetUsable ? '可用' : '不可用'}）`)
      return { ok: true, message: `已连接的远程工作区：\n${lines.join('\n')}`, workspaces: list }
    },
  })), `${name}: remote_list`)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'remote_disconnect',
    description: '断开一个远程工作区（不会删除本地镜像，重连后界面立刻有内容）。',
    parameters: {
      id: { type: 'string', required: true, description: '连接档案标识' },
    },
    output: textOutput(),
    async execute(args) {
      const removed = await connections.disconnect(args.id)
      audit.record(removed ? 'disconnect' : 'disconnect-noop', { profileId: args.id })
      return removed
        ? { ok: true, message: `已断开 ${args.id}。本地镜像保留在锚点目录里。` }
        : { ok: false, message: `没有名为 ${args.id} 的已连接工作区。` }
    },
  })), `${name}: remote_disconnect`)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'remote_refresh',
    description: '重新拉取远程项目的目录结构到本地镜像（远程被他人改动后用）。',
    parameters: {
      id: { type: 'string', required: true, description: '连接档案标识' },
    },
    output: textOutput(),
    async execute(args) {
      const workspace = connections.get(args.id)
      if (workspace === undefined) {
        return { ok: false, message: `没有名为 ${args.id} 的已连接工作区。` }
      }
      const report = await workspace.refresh()
      const errors = report.errors ?? []
      return {
        ok: errors.length === 0,
        message:
          `镜像已刷新：写入 ${report.written ?? 0} 个文件，` +
          `跳过未变化 ${report.unchanged ?? 0} 个，超大跳过 ${report.oversized ?? 0} 个。` +
          (report.truncated ? `\n⚠️ 遍历被边界截断（${(report.reasons ?? []).join(', ')}）。` : '') +
          (errors.length === 0
            ? ''
            : `\n⚠️ ${errors.length} 个路径读取失败：\n${errors.slice(0, 5).map((entry) => `  - ${entry.path}：${entry.message}`).join('\n')}`),
        report,
      }
    },
  })), `${name}: remote_refresh`)

  // ── 自检路由 ────────────────────────────────────────────────────────────
  // 全部套 `fence`：我们的路由**不在**宿主 `/api` 前缀下，宿主不会替我们挡
  // Host/Origin。不挡的话，浏览器里的任意网页都能打本地这个端口
  // （参考项目有真实事故：不校验 Origin 的本地接口 → 任何网页都能建隧道）。
  //
  // ⚠️ 审计**必须在 fence 之外**记：`fence()` 内部先判、拒绝时直接返回，
  // 所以「写在 fence 的 handler 里」的记录在拒绝路径上根本不会执行（实测踩到）。
  // 这里自己先判一次（纯函数、无副作用），把拒绝记进审计，再交给 fence 发响应。
  const fenced = (handler) => {
    const guarded = fence(handler, { trustedHosts: config.trustedHosts ?? [] })
    return (req, res) => {
      const verdict = checkRequestFence(req, { trustedHosts: config.trustedHosts ?? [] })
      if (!verdict.ok) {
        audit.record('fence-rejected', {
          path: req.url ?? null,
          method: req.method ?? null,
          status: verdict.status,
          reason: verdict.reason ?? null,
          host: req.headers?.host ?? null,
        })
      }
      return guarded(req, res)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PING,
    handler: fenced((req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        plugin: name,
        version: VERSION,
        uptimeMs: Date.now() - startedAt,
        tools: TOOL_NAMES,
        connected: connections.list(),
      })
    }),
  }), `${name}: ${ROUTE_PING} 路由`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_SELFCHECK,
    handler: fenced(async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const toolStatus = TOOL_NAMES.map((toolName) => ({
        name: toolName,
        registered: ctx.tools.get(toolName) !== undefined,
        visibleToModel: ctx.tools.schemas().some((schema) => schema.name === toolName),
      }))

      // 预设诊断：这是「有没有静默降级」的唯一可见答案
      let presets = []
      try {
        const inventory = await ctx.agentPresets.compositionInventory()
        presets = inventory
          .filter((row) => typeof row.id === 'string' && row.id.startsWith('multi-remote-'))
          .map((row) => ({
            id: row.id,
            broken: row.broken ?? null,
            rows: Array.isArray(row.rows) ? row.rows.length : null,
          }))
      } catch (error) {
        presets = [{ error: String(error?.message ?? error) }]
      }

      // 后端可用性：先回答「这台机器上哪种后端能用」，再谈具体连接。
      // `?backends=0` 可以跳过（探测要几秒，脚本里只想要工具状态时用得上）。
      let backends = null
      if (new URL(req.url ?? '/', 'http://localhost').searchParams.get('backends') !== '0') {
        try {
          backends = await probe()
        } catch (error) {
          backends = { error: String(error?.message ?? error) }
        }
      }

      sendJson(res, 200, {
        ok: toolStatus.every((entry) => entry.registered && entry.visibleToModel),
        plugin: name,
        version: VERSION,
        tools: toolStatus,
        presets,
        backends,
        transports: registeredProfileIds(),
        profileStore: profileStoreDir ?? null,
        // 审计摘要（明细在 /multi-remote/audit）：自检里只给条数，避免刷屏
        audit: { total: audit.read({ limit: 1 }).total, dropped: audit.read({ limit: 1 }).dropped },
      })
    }),
  }), `${name}: ${ROUTE_SELFCHECK} 路由`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_WORKSPACES,
    handler: fenced((req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      // 只给安全描述（describe() 已剥掉全部凭据）
      sendJson(res, 200, { ok: true, workspaces: connections.list() })
    }),
  }), `${name}: ${ROUTE_WORKSPACES} 路由`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_AUDIT,
    handler: fenced((req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams
      const limit = params.get('limit')
      const event = params.get('event')

      // `?clear=1` 清空（排查完想重新观察时用）
      if (params.get('clear') === '1') {
        const cleared = audit.clear()
        audit.record('audit-cleared', { cleared })
        sendJson(res, 200, { ok: true, cleared })
        return
      }

      const page = audit.read({
        ...limit === null ? {} : { limit: Number(limit) || undefined },
        ...event === null ? {} : { event },
      })
      sendJson(res, 200, { ok: true, ...page })
    }),
  }), `${name}: ${ROUTE_AUDIT} 路由`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_UI_OPTIONS,
    handler: fenced(async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      // 界面要渲染「远程开发」表单时需要知道的东西。
      // ⚠️ 刻意**不含凭据** —— 档案里的密码可能过期，回显会让用户以为「它记得」。
      //
      // `targets` 是**自动识别出来的可选项**（WSL 发行版 / Docker 容器）：
      // 有了它，用户就不用盲填发行版名和容器名 —— 那些填错了连接照样「成功」，
      // 但之后每条命令都失败，非常难排查。
      let targets = null
      try {
        targets = await listTargetsFn()
      } catch (error) {
        targets = { error: String(error?.message ?? error) }
      }

      sendJson(res, 200, {
        ok: true,
        // 关掉之后 `+` 按钮完全恢复官方行为（见 cordis.patch.yml 的 config）
        workspaceFlow: config.workspaceFlow !== false,
        anchorParent: defaultAnchorParent(),
        kinds: ['wsl', 'ssh', 'docker'],
        profiles: describeProfiles(typeof profileStoreDir === 'string' ? await listProfiles(profileStoreDir) : []),
        machines: machines.list(),
        targets,
      })
    }),
  }), `${name}: ${ROUTE_UI_OPTIONS} 路由`)

  // 「打开文件夹」：界面不自己弹窗，而是让我们去调宿主的目录选择服务。
  // 好处：**和官方 `+` 按钮用的是同一个系统窗口**，行为一致；
  // 也只有这样，客户端半边才不必声明对某个客户端 UI 包的依赖。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_UI_PICK,
    handler: fenced(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      // 刻意**不**写进 inject：这个服务是 web 半边提供的，
      // 声明成硬依赖会让「没有它的 profile」整个插件挂不上去。
      const picker = ctx.get('directoryPickerController')
      if (picker === undefined || typeof picker.pick !== 'function') {
        sendJson(res, 501, {
          ok: false,
          error: '这个 profile 没有目录选择服务（directoryPickerController），请改用「远程开发」或手工打开文件夹',
        })
        return
      }
      try {
        const controller = new AbortController()
        // 用户可能一直不选 —— 5 分钟兜底，避免请求永远挂着
        const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000)
        let picked
        try {
          picked = await picker.pick(controller.signal)
        } finally {
          clearTimeout(timer)
        }
        audit.record('ui-pick-directory', { picked: typeof picked === 'string' })
        sendJson(res, 200, { ok: true, path: typeof picked === 'string' ? picked : null })
      } catch (error) {
        audit.record('ui-pick-directory-failed', { code: error?.code ?? null })
        sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
      }
    }),
  }), `${name}: ${ROUTE_UI_PICK} 路由`)

  // 界面发起的「连接一个远程工作区」。与 `remote_connect` 工具**走同一套内部实现**，
  // 差别只在入口 —— 所以两边不会漂移。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_UI_CONNECT,
    handler: fenced(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let input
      try {
        input = normalizeConnectRequest(await readJsonBody(req))
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        return
      }

      // 界面用户不该被要求起连接名 —— 没填 id 就按「后端+远程根」自动生成
      if (typeof input.id !== 'string' || input.id === '') {
        input.id = deriveConnectId(input.kind, input.remoteRoot)
      }

      // **幂等**：同一档案已经连着同一目录 → 直接复用，不报「已经连上了」。
      // （用户多点一次「连接」是极常见操作，报错反而像坏了。）
      const already = connections.list().find((entry) => entry.id === input.id)
      if (already !== undefined) {
        if (already.remoteRoot === input.remoteRoot) {
          audit.record('connect-reused', { profileId: already.id, via: 'ui' })
          sendJson(res, 200, { ok: true, ...describeConnected(already), note: '该目录已在连接中，直接复用' })
        } else {
          sendJson(res, 200, {
            ok: false,
            error: `连接名 ${input.id} 已被另一个目录占用（${already.remoteRoot}）。请在「已保存的连接」里换一个名字，或先断开它。`,
          })
        }
        return
      }

      try {
        const workspace = await connections.connect({
          ...input,
          anchorParent: input.anchorParent ?? defaultAnchorParent(),
        })
        const described = workspace.describe()

        let persistNote = ''
        if (typeof profileStoreDir === 'string') {
          try {
            await saveProfile(profileStoreDir, workspace.profile)
          } catch (error) {
            persistNote = `档案没能保存，下次要重新输入：${error?.message ?? error}`
          }
        }

        const summary = describeConnected(described)
        // 审计里**不含凭据**（input 里有 password 也不能进）
        audit.record('connect-ok', { ...summary, via: 'ui' })
        sendJson(res, 200, { ok: true, ...summary, note: persistNote })
      } catch (error) {
        audit.record('connect-failed', {
          via: 'ui',
          profileId: typeof input.id === 'string' ? input.id : null,
          kind: input.kind,
          code: error?.code ?? null,
          // 日志写入时统一脱敏（见 audit.js 的 redact）—— 这里不必也不该自己拼
          message: String(error?.message ?? error),
        })
        sendJson(res, 200, { ok: false, error: String(error?.message ?? error), code: error?.code ?? null })
      }
    }),
  }), `${name}: ${ROUTE_UI_CONNECT} 路由`)

  // ── 「先连机器、再选文件夹」──────────────────────────────────────────────
  // 用户提的流程，也正是 VS Code / ZCode 的做法：
  //   先连机器（不要求项目根）→ 浏览远程真实目录 → 点选一个 → 它成为工作区。
  // 好处是**路径不再靠盲填**（盲填填错会让连接「成功」但每条命令都失败）。

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_UI_MACHINE_CONNECT,
    handler: fenced(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        const machine = await machines.connect(await readJsonBody(req))

        // **存档案** —— 否则界面里的「用过的连接」永远是空的（用户实测反馈：
        // 两步流程以前一条都不存，只有 `remote_connect` 工具那条路会存）。
        //
        // 存的是**机器级**档案（`machine: true`，没有项目根）：第一步只需要
        // 主机 / 账号 / 私钥路径，项目根是第二步选出来的。
        // `saveProfile` 会剥掉 password / privateKey / passphrase / agent —— 凭据永不落盘。
        if (typeof profileStoreDir === 'string') {
          try {
            const connected = machines.get(machine.id)
            if (connected !== undefined) {
              await saveProfile(profileStoreDir, {
                ...connected.profile,
                machine: true,
                label: machine.label,
              })
            }
          } catch (error) {
            log?.warn?.('[dsh-multi-remote] 机器档案没能保存：%s', error?.message ?? error)
          }
        }

        audit.record('machine-connect', { machineId: machine.id, kind: machine.kind, target: machine.target })
        sendJson(res, 200, { ok: true, machine })
      } catch (error) {
        audit.record('machine-connect-failed', { code: error?.code ?? null, message: String(error?.message ?? error) })
        sendJson(res, 200, { ok: false, error: String(error?.message ?? error), code: error?.code ?? null })
      }
    }),
  }), `${name}: ${ROUTE_UI_MACHINE_CONNECT} 路由`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_UI_MACHINE_LIST,
    handler: fenced(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const listing = await machines.listDir(String(body.machineId ?? ''), body.path)
        sendJson(res, 200, { ok: true, ...listing })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
      }
    }),
  }), `${name}: ${ROUTE_UI_MACHINE_LIST} 路由`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_UI_MACHINE_OPEN,
    handler: fenced(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        return
      }
      const machine = machines.get(String(body.machineId ?? ''))
      if (machine === undefined) {
        sendJson(res, 200, { ok: false, error: '机器连接已失效（可能已断开），请重新连接机器。' })
        return
      }
      const remoteRoot = String(body.remoteRoot ?? '').trim()
      if (!remoteRoot.startsWith('/')) {
        sendJson(res, 200, { ok: false, error: '远程项目根必须是绝对 POSIX 路径（以 / 开头）' })
        return
      }

      try {
        // 复用机器的档案（含凭据）＋ 选中的目录；**连接档案 id 按目录重新推导**
        // —— 否则同一台机器上的第二个项目会撞 id（`档案 X 已经连接`）。
        const input = {
          ...machine.profile,
          id: deriveConnectId(machine.kind, remoteRoot),
          remoteRoot,
          anchorParent: typeof body.anchorParent === 'string' && body.anchorParent !== '' ? body.anchorParent : defaultAnchorParent(),
        }
        const workspace = await connections.connect(input)
        const described = workspace.describe()
        const summary = describeConnected(described)
        audit.record('connect-ok', { ...summary, via: 'ui-machine' })
        sendJson(res, 200, { ok: true, ...summary, title: workspaceTitle(summary.kind, summary.remoteRoot) })
      } catch (error) {
        audit.record('connect-failed', {
          via: 'ui-machine',
          kind: machine.kind,
          code: error?.code ?? null,
          message: String(error?.message ?? error),
        })
        sendJson(res, 200, { ok: false, error: String(error?.message ?? error), code: error?.code ?? null })
      }
    }),
  }), `${name}: ${ROUTE_UI_MACHINE_OPEN} 路由`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_UI_MACHINE_DISCONNECT,
    handler: fenced(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const removed = await machines.disconnect(String(body.machineId ?? ''))
        audit.record('machine-disconnect', { machineId: String(body.machineId ?? ''), removed })
        sendJson(res, 200, { ok: true, removed })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
      }
    }),
  }), `${name}: ${ROUTE_UI_MACHINE_DISCONNECT} 路由`)
  // 把锚点目录建成工作区，并**起一个能看懂的名字**（`ssh:/home/user/my-proj/my-proj`）。
  //
  // 为什么在宿主侧做：客户端要先 `ctx.get('workspaces')` 再创建，实测**拿不到** ——
  // 于是自动创建失败，界面退化成「请手工打开这个目录」的提示（用户看到的正是那句）。
  // 宿主侧能直接访问 `workspaceRegistry`，而且 `create(path, title)` 支持标题。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_UI_OPEN_WORKSPACE,
    handler: fenced(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body
      try {
        body = await readJsonBody(req, 8192)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        return
      }
      const anchorPath = String(body.anchorPath ?? '').trim()
      if (anchorPath === '') {
        sendJson(res, 200, { ok: false, error: '缺少锚点目录' })
        return
      }
      // 刻意**不**写进 inject：没有工作区服务的 profile 不该因此整个插件挂不上
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.create !== 'function') {
        sendJson(res, 501, { ok: false, error: '这个 profile 没有工作区服务（workspaceRegistry），无法自动建工作区' })
        return
      }
      try {
        const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : undefined
        const workspace = await registry.create(anchorPath, title)
        const workspaceId = workspace?.id ?? workspace?.workspace?.id ?? null
        audit.record('ui-open-workspace', { workspaceId, title: title ?? null, anchorPath })
        sendJson(res, 200, { ok: true, workspaceId, title: title ?? null })
      } catch (error) {
        audit.record('ui-open-workspace-failed', { message: String(error?.message ?? error) })
        sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
      }
    }),
  }), `${name}: ${ROUTE_UI_OPEN_WORKSPACE} 路由`)
  // 客户端半边的自诊断上报。
  // **为什么需要**：客户端在浏览器里跑，出问题时我们看不到它的控制台 ——
  // 「点 `+` 没反应」只能靠猜（实测就吃过一次亏：注册写在异步回调里，静默失效）。
  // 有了这条，界面把「走到哪一步」报回来，我们从审计日志就能读。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_UI_CLIENT_REPORT,
    handler: fenced(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let report
      try {
        report = normalizeClientReport(await readJsonBody(req, 8 * 1024))
      } catch (error) {
        // 上报只是诊断，不把错误抛给界面
        sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
        return
      }
      audit.record('client-report', report)
      sendJson(res, 200, { ok: true })
    }),
  }), `${name}: ${ROUTE_UI_CLIENT_REPORT} 路由`)

  // ── 插件设置（读 / 改）──────────────────────────────────────────────────
  //
  // 改配置**不自己写文件** —— 走宿主的 `configEditor` 服务：它负责校验、持久化，
  // 并**走正常 Loader 路径重新应用**（也就是说改完插件会重载）。
  //
  // 刻意**不写进 `inject`**：这个服务是可选能力，声明成硬依赖会让没有它的 profile
  // 整个插件挂不上去 —— 那时界面应当如实说「改不了」，并给出手工办法。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_UI_SETTINGS,
    handler: fenced(async (req, res) => {
      const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined
      const canEdit = editor !== undefined && typeof editor.edit === 'function' && typeof editor.entries === 'function'

      if (req.method === 'GET') {
        // 界面要显示的是**当前生效值**（不是「档案里写了什么」）
        sendJson(res, 200, {
          ok: true,
          editable: canEdit,
          config: {
            workspaceFlow: config.workspaceFlow !== false,
            auditCapacity: audit.read({ limit: 1 }).capacity,
            mirrorDeepen: {
              enabled: deepenCfg.enabled !== false,
              maxFileBytes: deepenBounds.maxFileBytes,
              maxTotalBytes: deepenBounds.maxTotalBytes,
            },
          },
          limits: SETTINGS_LIMITS,
        })
        return
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }

      if (!canEdit) {
        sendJson(res, 200, {
          ok: false,
          error: '这个 profile 没有 configEditor 服务，界面改不了配置。'
            + '可以手工改 profile 的 cordis.patch.yml 里 multi-remote 那一行的 config。',
        })
        return
      }

      let patch
      try {
        patch = normalizeSettingsPatch(await readJsonBody(req))
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        return
      }

      // 找到**我们自己那一行**。
      //
      // ⚠️ Entry 的形状是实测出来的（2026-10-09）：包名在 **`entry.options.name`** 里，
      // `entry.name` / `entry.patchId` 都是 `null`，`entry.id` 是 `include:multi-remote`
      // （我们这一行是 bundle 里 insert 的，挂在 include 树下）。
      // 一开始按 `entry.name` 找 → 永远找不到 → 用户点保存得到「找不到本插件那一行」。
      const entry = editor.entries().find((candidate) =>
        candidate?.options?.name === name
        || candidate?.id === 'multi-remote'
        || candidate?.id === `include:multi-remote`)
      if (entry === undefined) {
        sendJson(res, 200, {
          ok: false,
          error: '在配置树里找不到本插件那一行，没法保存。可以手工改 profile 的 cordis.patch.yml。',
        })
        return
      }

      try {
        await editor.edit(entry, (current) => {
          const next = { ...(current ?? {}) }
          if (patch.workspaceFlow !== undefined) next.workspaceFlow = patch.workspaceFlow
          if (patch.auditCapacity !== undefined) next.auditCapacity = patch.auditCapacity
          if (patch.mirrorDeepen !== undefined) {
            const base = typeof next.mirrorDeepen === 'object' && next.mirrorDeepen !== null ? next.mirrorDeepen : {}
            next.mirrorDeepen = { ...base, ...patch.mirrorDeepen }
          }
          return next
        })
        // 审计里**记字段名不记值**就够定位了；值可能有路径等，没必要留
        audit.record('settings-saved', { keys: Object.keys(patch).join(',') })
        sendJson(res, 200, {
          ok: true,
          applied: patch,
          note: '已保存。插件会重载 —— 已连接的远程工作区会断开，重新连一次即可。',
        })
      } catch (error) {
        audit.record('settings-failed', { message: String(error?.message ?? error) })
        sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
      }
    }),
  }), `${name}: ${ROUTE_UI_SETTINGS} 路由`)

  log?.info?.('[dsh-multi-remote] 已就绪：%d 个工具、9 条路由、会话绑定钩子', TOOL_NAMES.length)
}

/** 供测试与诊断复用。 */
export { normalizeProfile, ProfileError }