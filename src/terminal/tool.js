/**
 * 模型可见的**远程交互式终端**工具。
 *
 * ## 为什么需要一个工具（而不是只注册 backend）
 *
 * 宿主把终端拆成三层：`ctx.terminals`（身份/授权/清理）、`TerminalBackend`（怎么开）、
 * 以及**工具**（怎么呈现给模型）。本机自带的那个工具包（`dsh-tool-terminal`）
 * 在这个发行版里**没有安装** —— 实测 asar 里只有 `dsh-terminal` 与 `dsh-terminal-bash`。
 * 所以「模型能用上终端」这件事必须由我们把工具补上。
 *
 * ## 与 `remote_bash` 的区别（这是给模型看的核心信息）
 *
 * | | `remote_bash` | `remote_terminal` |
 * |---|---|---|
 * | 模型 | 一次性：跑完拿结果 | **持久**：状态跨调用保留 |
 * | 状态 | 每次都是新进程 | cwd / 环境变量 / 函数 / 后台任务都留着 |
 * | 适合 | 有界的命令 | 调试器、REPL、需要反复交互的会话 |
 * | 不适合 | 需要交互的程序 | 有界的一次性命令（终端更难做输出边界与超时） |
 *
 * 所以工具描述里必须**明确劝退误用** —— 否则模型会拿终端去跑 `ls`，
 * 白白多绕一圈，还失去了 `remote_bash` 的输出上限与超时保护。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { routeByAnchorPath } from '../session/workspace-routes.js'

/** 终端会话在工具参数里的标识（模型看到的是短 id，不是宿主的长 id）。 */
const SESSION_PREFIX = 'term'

/**
 * 建 `remote_terminal` 工具。
 *
 * @param {object} options
 * @param {object} options.terminals 宿主的 `ctx.terminals`（域内解析到的那个）
 * @param {() => string|undefined} options.labelOf 当前是哪台机器（给描述用）
 * @param {(message: string, ...rest: unknown[]) => void} [options.log]
 */
export function buildTerminalTool(options) {
  const { terminals, labelOf, log } = options

  /**
   * 短 id ↔ 宿主 id 的映射。
   * **每个工具实例一份** —— 不同隔离域（不同远程连接）之间不共享，
   * 否则 A 会话的 `term-1` 会指到 B 会话的终端。
   */
  const idMap = new Map()

  /** 宿主给的是 `pty-N` 这种 id；模型看到的是 `term-N`。 */
  const shortId = (hostId) => {
    for (const [short, host] of idMap) {
      if (host === hostId) return short
    }
    return hostId
  }

  /**
   * 把一次调用的结果渲染成给模型看的文本。
   * 刻意**不省略** `waitReason` —— 模型必须知道「跑完了」是推断的还是确定的。
   */
  const renderSend = (result, sessionId) => {
    const lines = []
    lines.push(`[${sessionId}] waitReason=${result.waitReason}`)
    if (result.waitReason === 'inferred_idle') {
      lines.push('（注意：这是「一段时间没有新输出」的推断，不是「命令已结束」。长命令请调大 timeoutMs 或再 read 一次确认。）')
    } else if (result.waitReason === 'timeout') {
      lines.push('（注意：等到了超时。命令**可能还在跑**，只是没有新输出。）')
    } else if (result.waitReason === 'session_exit') {
      lines.push('（终端已退出。）')
    }
    if (result.truncated === true) lines.push('（输出被截断 —— 只保留了最近的部分。）')
    lines.push('--- 输出 ---')
    lines.push(result.viewport === '' ? '(无输出)' : result.viewport)
    return lines.join('\n')
  }

  return defineTool({
    name: 'remote_terminal',
    description:
      '在**远程目标**上开一个持久的交互式终端（PTY），或者与已有的终端交互。\n\n' +
      '**什么时候该用**：需要跨多次调用保留状态的场景 —— 步进调试器、Python/Node REPL、\n' +
      '需要先 cd 再反复执行的探索、跑一个交互式程序并看它的实时输出。\n\n' +
      '**什么时候不该用**：有界的一次性命令请用 `remote_bash`。它更省事，而且有\n' +
      '输出上限与超时保护；终端这两方面都更弱。别拿终端去跑 `ls` 这种命令。\n\n' +
      '**关于「跑完了」**：终端里没有「命令结束」的信号，只能推断。返回的 `waitReason`\n' +
      '告诉你结论有多可靠：`session_exit` 最确定；`inferred_idle` 是「一段时间没输出」的\n' +
      '推断（慢命令可能误判）；`timeout` 表示到点了但**命令可能还在跑**。\n\n' +
      'action 的取值：\n' +
      "  - 'open'：开一个新终端（可选 name 起个名、cwd 指定初始目录）\n" +
      "  - 'send'：往终端里发文本（submit=true 会补回车）、并等它安静下来\n" +
      "  - 'read'：只读输出，不发送任何东西（看长任务进展用）\n" +
      "  - 'signal'：发信号（SIGINT 中断当前命令、SIGTERM/SIGKILL 结束）\n" +
      "  - 'list'：列出这个会话拥有的终端\n" +
      "  - 'close'：关掉终端（会真的结束远端进程）",
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: "'open' / 'send' / 'read' / 'signal' / 'list' / 'close'",
      },
      sessionId: { type: 'string', description: '终端标识（open 返回；send/read/signal/close 必填）' },
      name: { type: 'string', description: "open 时给终端起个名（如 'debug'、'repl'）" },
      cwd: { type: 'string', description: 'open 时的初始目录（远程绝对路径）' },
      text: { type: 'string', description: 'send 时发送的文本' },
      submit: { type: 'boolean', description: 'send 时是否补一个回车（默认 true）' },
      timeoutMs: { type: 'number', description: 'send 最多等多久（默认 30000）' },
      signal: { type: 'string', description: "signal 时发哪个信号（SIGINT / SIGTERM / SIGKILL / SIGTSTP / SIGHUP）" },
      offset: { type: 'number', description: 'read 时的分页偏移（0 = 最新）' },
      count: { type: 'number', description: 'read 时最多返回多少行' },
    },
    // `output` 必须是 `{ schema, render }`，不是裸 schema ——
    // 给裸 schema 会被宿主拒绝：`unsupported JSON schema: schema must be a value schema object`。
    // 而且这条错误会让**整个预设激活失败**（预设诊断把它标成 broken），
    // 会话因此拒绝连接 —— 失败得很响亮，这是好事。
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
    },
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined) {
        return { ok: false, message: '拿不到当前会话，无法操作终端。' }
      }
      const action = String(args.action ?? '').trim()

      try {
        switch (action) {
          case 'open': {
            // 方案 A：终端按 cwd 路由。agent 没指定 cwd 时，按**会话 cwd（锚点）**
            // 路由出对应项目的远程根 —— 这样默认就开在正确项目里。
            let cwd = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd : undefined
            if (cwd === undefined) {
              cwd = routeByAnchorPath(exec.agent?.session?.header?.cwd)?.remoteRoot
            }
            if (cwd === undefined) {
              return { ok: false, message: '无法确定终端连到哪个远程项目（请先打开对应项目，或指定 cwd）。' }
            }
            const spawned = await terminals.spawn(agent, {
              type: 'remote-shell',
              ...args.name === undefined ? {} : { name: String(args.name) },
              cwd: String(cwd),
            })
            const id = shortId(spawned.sessionId)
            idMap.set(id, spawned.sessionId)
            return {
              ok: true,
              sessionId: id,
              message:
                `已开终端 [${id}]（${labelOf() ?? '远程'}）。\n` +
                `${spawned.motd ?? ''}\n` +
                '接下来用 action=\'send\' 往里面发命令。',
            }
          }

          case 'list': {
            const sessions = terminals.list(agent).map((snapshot) => ({
              sessionId: shortId(snapshot.sessionId),
              name: snapshot.name ?? null,
              type: snapshot.type,
              status: snapshot.status,
            }))
            return {
              ok: true,
              sessions,
              message: sessions.length === 0
                ? '这个会话还没有开过终端。'
                : sessions
                  .map((s) => `[${s.sessionId}]${s.name === null ? '' : ` (${s.name})`} ${s.status.kind === 'exited' ? `已退出（exit=${s.status.exitCode}）` : '运行中'}`)
                  .join('\n'),
            }
          }

          case 'send': {
            const resolved = resolveId(args.sessionId, idMap)
            if (resolved === undefined) return { ok: false, message: 'send 需要 sessionId。' }
            const operation = terminals.startSend(agent, resolved, {
              text: String(args.text ?? ''),
              submit: args.submit !== false,
              timeoutMs: args.timeoutMs === undefined ? undefined : Number(args.timeoutMs),
            })
            const result = await operation.done
            return {
              ok: true,
              sessionId: shortId(resolved),
              message: renderSend(result, shortId(resolved)),
              waitReason: result.waitReason,
              sessionStatus: result.sessionStatus,
            }
          }

          case 'read': {
            const resolved = resolveId(args.sessionId, idMap)
            if (resolved === undefined) return { ok: false, message: 'read 需要 sessionId。' }
            const read = terminals.read(agent, resolved, {
              ...args.offset === undefined ? {} : { offset: Number(args.offset) },
              ...args.count === undefined ? {} : { count: Number(args.count) },
            })
            return {
              ok: true,
              sessionId: shortId(resolved),
              message:
                `[${shortId(resolved)}] 共 ${read.totalLines} 行` +
                `${read.truncated ? '（已截断，只保留最近的部分）' : ''}\n` +
                `--- 输出 ---\n${read.text === '' ? '(无输出)' : read.text}`,
            }
          }

          case 'signal': {
            const resolved = resolveId(args.sessionId, idMap)
            if (resolved === undefined) return { ok: false, message: 'signal 需要 sessionId。' }
            const name = String(args.signal ?? 'SIGINT').toUpperCase()
            const result = await terminals.signal(agent, resolved, name)
            return {
              ok: true,
              sessionId: shortId(resolved),
              message: `已发送 ${name}（delivered=${String(result.delivered)}）。用 action='read' 看结果。`,
            }
          }

          case 'close': {
            const resolved = resolveId(args.sessionId, idMap)
            if (resolved === undefined) return { ok: false, message: 'close 需要 sessionId。' }
            const closed = await terminals.kill(agent, resolved, '模型请求关闭')
            idMap.delete(shortId(resolved))
            return {
              ok: true,
              sessionId: shortId(resolved),
              message: closed ? '已关闭终端（远端进程已结束）。' : '这个终端正在关闭中（重复请求已忽略）。',
            }
          }

          default:
            return {
              ok: false,
              message: `不认识的 action：${action}。可用：open / send / read / signal / list / close。`,
            }
        }
      } catch (error) {
        // 宿主契约的错误码原样透出，便于模型/用户判断是「没有这个终端」还是「别人的终端」
        const code = error?.code
        const suffix = typeof code === 'string' ? `（code=${code}）` : ''
        log?.('[terminal] %s 失败：%s', action, String(error?.message ?? error))
        return { ok: false, message: `终端操作失败${suffix}：${error?.message ?? error}` }
      }
    },
  })
}

/** 把模型给的短 id 或原始 id 解析回宿主 id。 */
function resolveId(value, map) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const trimmed = value.trim()
  if (map.has(trimmed)) return map.get(trimmed)
  // 也接受直接给宿主 id（`pty-N`），便于手工排查
  if (/^pty-\d+$/.test(trimmed)) return trimmed
  return undefined
}

export { SESSION_PREFIX }
