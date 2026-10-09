/**
 * 隔离域内的**远程终端**挂载点。
 *
 * 与 `world/fs.js`、`world/shell.js` 同一套路：**只在预设的隔离域里挂载**，
 * 全局的 `ctx.terminals` / 本机终端完全不受影响。
 *
 * ## 这一层做两件事
 *
 * 1. **注册 `TerminalBackend`**（类型 `remote-shell`）——
 *    之后 `ctx.terminals.spawn(owner, { type: 'remote-shell' })` 开出来的就是远程终端。
 * 2. **注册模型可见的工具 `remote_terminal`** ——
 *    本机自带的终端工具包在这个发行版里没有安装，所以工具得我们自己补
 *    （实测 asar 里只有 `dsh-terminal` 与 `dsh-terminal-bash`，没有 `dsh-tool-terminal`）。
 *
 * ## 为什么后端类型不叫 `shell`
 *
 * `ctx.terminals.registerBackend` 把后端存进**服务级**的 Map，同名会抛
 * `DUPLICATE_BACKEND`。官方那个本地 shell 后端占用了 `shell`，所以我们必须用别的名字。
 * 这也正好：模型在远程会话里开终端，本来就该走远程后端。
 */
import { routeByRemotePath } from '../session/workspace-routes.js'
import { RemoteTerminalBackend, REMOTE_TERMINAL_TYPE, registerRemoteTerminalBackend } from '../terminal/backend.js'
import { buildTerminalTool } from '../terminal/tool.js'

export const name = '@jk-uzi/dsh-multi-remote/world-terminal'

/**
 * 域内需要的服务。
 *
 * `terminals` 是宿主**单例**服务（后端表在服务级，不随隔离域分家），
 * 但我们注册的后端实例**按 cwd 路由 transport** —— 所以域内开出来的终端
 * 永远连到 cwd 所属的那台远程机器。
 */
export const inject = ['terminals', 'tools']

/**
 * 方案 A：后端**不再绑固定连接**，开终端时按 cwd 路由。
 */
export function apply(ctx, config = {}) {
  const label = config.label ?? '远程'
  const log = ctx.logger

  // 把挂载过程写进一个进程内可读的痕迹，便于探针/自检确认它到底跑到哪一步。
  // （域内的 logger 未必可见，所以自己记一份。）
  const trace = (step, detail) => {
    try {
      const g = globalThis
      g.__DSH_MR_TERMINAL_TRACE ??= []
      g.__DSH_MR_TERMINAL_TRACE.push({ step, detail: detail ?? null, at: Date.now() })
    } catch {
      // 记录失败不该影响挂载
    }
  }
  trace('apply-start', { hasTerminals: (ctx.get?.('terminals') ?? ctx.terminals) !== undefined })

  // ── 1. 注册后端 ──────────────────────────────────────────────────────────
  const backend = new RemoteTerminalBackend({
    // 方案 A：spawn 时按 cwd（远程初始目录）路由到对应的 transport
    route: (cwd) => routeByRemotePath(cwd)?.transport,
    label,
    log: (...args) => log?.info?.(...args),
  })
  const unregister = registerRemoteTerminalBackend(ctx, backend)
  ctx.effect(() => () => unregister(), 'world-terminal: 注销远程终端后端')
  trace('backend-registered', { type: REMOTE_TERMINAL_TYPE })

  // ── 2. 注册工具 ──────────────────────────────────────────────────────────
  const terminals = ctx.get?.('terminals') ?? ctx.terminals
  trace('terminals-resolved', { present: terminals !== undefined, backends: terminals?.listBackends?.() ?? null })

  const tool = buildTerminalTool({
    terminals,
    labelOf: () => label,
    log: (...args) => log?.warn?.(...args),
  })
  ctx.effect(() => ctx.tools.register(tool), 'world-terminal: remote_terminal')
  trace('tool-registered', { name: 'remote_terminal' })

  // 注册后立刻回读：确认工具真的进了这个域解析到的 tools 服务。
  // 这一步很重要 —— 「register 被调用」和「工具真的可见」是两件事。
  try {
    const names = (ctx.tools.schemas?.() ?? []).map((schema) => schema.name ?? schema.function?.name).filter(Boolean)
    trace('tools-after-register', { count: names.length, hasOurs: names.includes('remote_terminal'), sample: names.slice(0, 12) })
  } catch (error) {
    trace('tools-after-register-failed', { error: String(error?.message ?? error) })
  }

  log?.info?.('[world-terminal] 隔离域终端已挂载（按 cwd 路由，类型 %s）', REMOTE_TERMINAL_TYPE)
}
