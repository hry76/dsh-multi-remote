/**
 * 远程搜索：`glob` / `grep` 的**远程实现**。
 *
 * ## 为什么必须自己写
 *
 * 宿主自带的 `glob` / `grep`（`@deepseek-ai/dsh-tool-fs-search`）用的是
 * **打包在宿主里的 ripgrep 可执行文件**，通过 `subprocess` 接缝启动 ——
 * 宿主源码注释写得很明确：*"execute as ordinary foreground spawns through
 * `ctx.subprocess` — never `ctx.shell`"*。
 *
 * 也就是说：**它跑在你本机**，搜的是**本地镜像**（打开工作区时同步下来的副本）。
 * 后果是「搜索看起来成功了，但会漏文件」：
 *
 * | 情况 | 本机镜像搜索 |
 * |---|---|
 * | 目录树里的文件（按名字找） | ✅ 能 |
 * | 打开工作区时小于 256 KiB 的文件（按内容找） | ✅ 能 |
 * | **大于 256 KiB 的文件** | ❌ 镜像里只有占位，搜不到 |
 * | 超过 12 层深 / 2 万条目之外 | ❌ 不在镜像里 |
 * | 远端刚改过、镜像还没刷新 | ⚠️ 可能拿到旧内容 |
 *
 * 这与「工作区在远程」是矛盾的 —— 所以这里**自己实现一份**，
 * 在隔离域内通过 `ctx.shell`（= 远程 shell）跑远程的 `find` / `grep`。
 *
 * ## 与宿主那份的差异（如实说明，不假装一样）
 *
 * - **正则方言**：用远程的 `grep -E`（POSIX 扩展正则），不是 ripgrep 语法。
 *   绝大多数常见写法一致；rg 特有的（如 `\p{...}`、lookaround）不支持。
 * - **`include` 里的大括号**（`*.{js,jsx}`）不支持 —— 退化成把它当普通字符（见下）。
 * - **忽略规则**：用与镜像层同一份内置忽略名单（`.git`、`node_modules` …），
 *   而不是读取远程的 `.gitignore`。**差异要在工具描述里说清楚，不静默**。
 * - **不做 spill 文件**：超过上限就截断，并**如实报告被截断了**（`truncated`）。
 *
 * ## 只做「远程」这一件事
 *
 * 路径翻译复用 `world/translate.js`（与 `world/fs`、`world/shell` 同一套规则），
 * 所以模型用锚点形态的路径也能搜。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { resolveRemotePath } from './translate.js'
import { shellQuote } from '../terminal/quote.js'

export const name = '@jk-uzi/dsh-multi-remote/world-search'

/** 需要的服务：工具注册表 + shell（**域内的** shell 才是远程实现）。 */
export const inject = ['tools', 'shell']

/** 一次搜索最多返回多少条结果（超过就截断并如实标注）。 */
export const DEFAULT_MAX_RESULTS = 200

/** 远程命令的输出上限（字节）。防止一条搜索把上下文撑爆。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024

/** 搜索超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 与镜像层同一份忽略名单 —— 用名字剪枝，而不是读远程的 `.gitignore`。
 *
 * 刻意只放「几乎不可能想搜」的目录：版本控制元数据、依赖、常见构建产物。
 */
export const PRUNED_DIRS = [
  '.git',
  'node_modules',
  '.pnpm-store',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
]

/**
 * 把 glob 模式翻译成 POSIX ERE（用于 `grep -E` 过滤路径）。
 *
 * 语义对齐宿主那份的说明：
 *   - 模式里**没有 `/`** → 匹配**任意深度下的文件名**（`*.ts` 等于 `**` + `/*.ts`）
 *   - 含 `/` → 从搜索根开始匹配整条相对路径
 *
 * @param {string} pattern
 * @returns {{ source: string, basenameOnly: boolean }}
 */
export function globToEre(pattern) {
  const raw = String(pattern ?? '').trim()
  if (raw === '') throw new Error('glob: pattern 不能为空')

  const basenameOnly = !raw.includes('/')
  const normalized = raw.replace(/^\.\//, '')

  let out = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]
    if (ch === '*') {
      // `**/` 跨越任意层；`**` 单独出现也当跨层；`*` 只在本层
      if (normalized[i + 1] === '*') {
        i += 1
        if (normalized[i + 1] === '/') i += 1
        out += '(.*/)?'
        continue
      }
      out += '[^/]*'
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    if (ch === '[') {
      // 字符类：原样透传（直到 `]`），并转义其中的反斜杠风险
      const end = normalized.indexOf(']', i + 1)
      if (end > i) {
        out += normalized.slice(i, end + 1)
        i = end
        continue
      }
      out += '\\['
      continue
    }
    out += /[A-Za-z0-9_/-]/.test(ch) ? ch : `\\${ch}`
  }

  return {
    // 只按文件名匹配时，前缀允许任意目录
    source: basenameOnly ? `^(\\./)?(.*/)?${out}$` : `^\\.?/?${out}$`,
    basenameOnly,
  }
}

/**
 * 展开 glob 里的大括号：`*.{js,jsx}` → `['*.js', '*.jsx']`。
 *
 * 为什么要做：`find -name` **不支持**大括号语法。如果直接把 `*.{js,jsx}`
 * 丢给 `find`，它会当成字面量、一个文件都匹配不到 —— 而工具会报告
 * 「没有匹配」。那是**误导**（用户以为真的没有），所以这里如实展开。
 *
 * 只处理一层、不嵌套（够用，且行为可预测）。
 *
 * @param {string} pattern
 * @returns {string[]}
 */
export function expandBraces(pattern) {
  const value = String(pattern ?? '').trim()
  const open = value.indexOf('{')
  if (open < 0) return [value]
  const close = value.indexOf('}', open + 1)
  if (close < 0) return [value]
  const prefix = value.slice(0, open)
  const suffix = value.slice(close + 1)
  return value
    .slice(open + 1, close)
    .split(',')
    .map((part) => `${prefix}${part.trim()}${suffix}`)
    .filter((part) => part !== '')
}

/** 构造 `find` 的剪枝表达式（`-name X -o -name Y`）。 */
function pruneExpression() {
  return PRUNED_DIRS.map((dir) => `-name ${shellQuote(dir)}`).join(' -o ')
}

/** 把一组 `-name` 模式拼成 find 表达式（单个不加括号，多个用 `\( … \)`）。 */
function nameExpression(patterns) {
  const clauses = patterns.map((pattern) => `-name ${shellQuote(pattern)}`)
  return clauses.length === 1 ? clauses[0] : `\\( ${clauses.join(' -o ')} \\)`
}

/**
 * 构造 `glob` 的远程命令。
 *
 * 用 `find -exec sh -c … stat -c "%Y %n"` 取「修改时间 + 路径」——
 * **不用 `-printf`**：busybox 的 `find` 没有它（实测踩过）。
 * 输出按修改时间倒序（与宿主那份的契约一致），再按上限截断。
 */
export function buildGlobCommand(options) {
  const { root, ere, cap } = options
  return [
    `cd ${shellQuote(root)} 2>/dev/null || exit 2`,
    `find . -type d \\( ${pruneExpression()} \\) -prune -o -type f -exec sh -c '`,
    '  for f in "$@"; do',
    '    stat -c "%Y %n" -- "$f" 2>/dev/null',
    '  done',
    // 这里的 `head` 只用来少传数据；`find` 出错的情况由 runRemote 的
    // 「输出为空 + stderr 有内容」兜底（stderr 不再被丢掉）。
    `' sh {} + | grep -E ${shellQuote(ere)} | sort -rn -k1,1 | head -n ${cap + 1}`,
  ].join('\n')
}

/**
 * 解析 `glob` 的输出。
 *
 * @param {string} stdout
 * @param {number} cap
 * @returns {{ paths: string[], truncated: boolean }}
 */
export function parseGlobOutput(stdout, cap) {
  const paths = []
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.replace(/\r$/, '')
    if (trimmed === '') continue
    // 格式：`<mtime> <path>`；路径里可以有空格，所以按**第一个**空格切
    const space = trimmed.indexOf(' ')
    if (space <= 0) continue
    let rel = trimmed.slice(space + 1)
    if (rel.startsWith('./')) rel = rel.slice(2)
    paths.push(rel)
  }
  const truncated = paths.length > cap
  return { paths: paths.slice(0, cap), truncated }
}

/**
 * 构造 `grep` 的远程命令。
 *
 * `-H` 多文件时带文件名、`-n` 行号、`-I` 跳过二进制。
 * `include` 支持简单 glob 与大括号（`*.{js,jsx}` 会展开成多个 `-name`）。
 */
export function buildGrepCommand(options) {
  const { root, pattern, include, cap } = options
  const rawInclude = typeof include === 'string' ? include.trim() : ''
  const includeClause = rawInclude === '' ? '' : ` ${nameExpression(expandBraces(rawInclude))}`
  // ⚠️ **刻意不接 `| head`**（虽然那样能少传点数据）：
  // 管道里 `head` 的退出码会盖掉 `grep` 的 —— 正则写错时 grep 报错退出 2，
  // 而整条管道仍然「成功」，工具于是报「没有匹配」。**那是静默失败。**
  // 现在把上限交给 `stdoutMaxBytes`（传输层截断）与 Node 侧的 `cap`。
  // 同理**不吞 stderr** —— 出错时要能把原因报出来（见 runRemote）。
  return [
    `cd ${shellQuote(root)} 2>/dev/null || exit 2`,
    `find . -type d \\( ${pruneExpression()} \\) -prune -o -type f${includeClause} -exec grep -nHI -E ${shellQuote(pattern)} {} +`,
  ].join('\n')
}

/**
 * 解析 `grep` 的输出（`-H -n` 的格式：`./path:line:text`）。
 *
 * 路径里**可能含冒号**（少见但合法），所以从**第一个**冒号找起，
 * 找第一个「冒号后全是数字」的位置当分隔符。
 *
 * @param {string} stdout
 * @param {number} cap
 */
export function parseGrepOutput(stdout, cap) {
  const matches = []
  for (const raw of String(stdout ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') continue
    // 找第一个「冒号 + 纯数字 + 冒号」当分隔符：路径里可能有冒号，不能从头切
    let split = -1
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] !== ':') continue
      const next = line.indexOf(':', i + 1)
      if (next < 0) break
      if (/^\d+$/.test(line.slice(i + 1, next))) {
        split = i
        break
      }
    }
    if (split < 0) continue
    const second = line.indexOf(':', split + 1)
    if (second < 0) continue
    let path = line.slice(0, split)
    if (path.startsWith('./')) path = path.slice(2)
    const lineNumber = Number(line.slice(split + 1, second))
    if (!Number.isFinite(lineNumber)) continue
    matches.push({ path, lineNumber, line: line.slice(second + 1) })
  }
  const truncated = matches.length > cap
  return { matches: matches.slice(0, cap), truncated }
}

/** 把相对路径与搜索根拼成给模型看的文本（与宿主那份的渲染风格一致）。 */
export function renderGlobText(paths, root, truncated, partial = false) {
  if (paths.length === 0) {
    return partial
      ? `没搜到匹配（根：${root}）—— ⚠️ 搜索**超时被中断**，所以「没搜到」不等于「不存在」；建议缩小 path 再试`
      : `没有匹配的文件（根：${root}）`
  }
  const lines = [`根：${root}`, ...paths.map((p) => `  ${p}`)]
  if (truncated) lines.push(`  …（结果被截断，只显示前 ${paths.length} 条；缩小 pattern 或 path 再搜）`)
  if (partial) lines.push('  ⚠️ 搜索超时被中断，以上**可能不完整** —— 建议缩小 path 再搜')
  return lines.join('\n')
}

/** 把 grep 结果渲染成文本（按文件分组）。 */
export function renderGrepText(matches, root, truncated, partial = false) {
  if (matches.length === 0) {
    return partial
      ? `没搜到匹配（根：${root}）—— ⚠️ 搜索**超时被中断**，所以「没搜到」不等于「不存在」；建议缩小 path 再试`
      : `没有匹配（根：${root}）`
  }
  const byFile = new Map()
  for (const match of matches) {
    if (!byFile.has(match.path)) byFile.set(match.path, [])
    byFile.get(match.path).push(match)
  }
  const lines = [`根：${root}`]
  for (const [path, items] of byFile) {
    lines.push(`${path}:`)
    for (const item of items) lines.push(`  ${item.lineNumber}: ${item.line}`)
  }
  if (truncated) lines.push(`…（结果被截断，只显示前 ${matches.length} 条）`)
  if (partial) lines.push('⚠️ 搜索超时被中断，以上**可能不完整** —— 建议缩小 path 再搜')
  return lines.join('\n')
}

/**
 * 挂载两个工具。
 *
 * @param {object} ctx
 * @param {{ profileId: string, remoteRoot: string, localAnchorPath?: string, maxResults?: number, timeoutMs?: number }} config
 */
export function apply(ctx, config = {}) {
  const profileId = config.profileId
  const remoteRoot = config.remoteRoot
  if (typeof profileId !== 'string' || profileId === '') {
    throw new Error('world-search: config.profileId 必填（拿不到就拒绝挂载，绝不回退到本机）')
  }
  if (typeof remoteRoot !== 'string' || !remoteRoot.startsWith('/')) {
    throw new Error('world-search: config.remoteRoot 必须是以 / 开头的绝对 POSIX 路径')
  }
  const localAnchorPath = typeof config.localAnchorPath === 'string' ? config.localAnchorPath : undefined
  const cap = config.maxResults ?? DEFAULT_MAX_RESULTS
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const log = ctx.logger
  const shell = ctx.shell

  const toRemote = (path) => resolveRemotePath(path ?? '.', { remoteRoot, localAnchorPath, cwd: remoteRoot, log })

  /** 跑一条远程命令并拿 stdout（失败要说得清，绝不返回空结果冒充成功）。 */
  const runRemote = async (command, signal) => {
    const spec = shell.resolve({ command, workdir: remoteRoot, timeoutMs, stdoutMaxBytes: DEFAULT_MAX_OUTPUT_BYTES, signal })
    const process = await shell.execute(spec)
    const result = await process.result()

    const stdout = String(result.stdout?.text ?? '')
    const stderr = String(result.stderr?.text ?? '').trim()

    // ⚠️ **超时不是错误** —— 改成「返回已找到的部分 + 如实标注不完整」（2026-10-07 实测改进）。
    //
    // 之前这里直接抛「搜索超时」，用户连的是整个家目录（`/home/user`），
    // 30 秒搜不完，于是**一条结果都拿不到**，只有一句报错。
    // 但 find/grep 是**边跑边输出**的：已经找到的部分完全有用。
    // 现在把部分结果返回去，并标明「可能不完整」，让模型能自己决定要不要缩窄。
    if (result.timedOut === true) {
      return { stdout, truncated: result.stdout?.truncated === true, partial: true }
    }

    // grep/find 的退出码 1 = 没有匹配；那是**正常结果**，不是失败
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      const detail = stderr.slice(0, 300)
      throw new Error(`远程搜索失败（exit ${result.exitCode}）${detail === '' ? '' : `：${detail}`}`)
    }
    // ⚠️ **输出为空但 stderr 有内容** → 不能报「没有匹配」。
    // 典型场景：`find` 报错、或 grep 因为别的原因什么都没输出。
    // 静默返回空结果会让模型以为「真的没有」，必须把原因说出来。
    if (stdout.trim() === '' && stderr !== '') {
      throw new Error(`远程搜索没有输出，但报错信息是：${stderr.slice(0, 300)}`)
    }
    return { stdout, truncated: result.stdout?.truncated === true, partial: false }
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'glob',
    description:
      '按文件名查找文件（**在远程执行**：用远程的 find，不受本地镜像边界影响）。' +
      'pattern 里没有 "/" 时按任意深度的文件名匹配（`*.ts` 等价于全树搜）；含 "/" 时从搜索根匹配整条相对路径。' +
      `默认按修改时间倒序返回最多 ${cap} 条。` +
      '已剪枝的目录：' + PRUNED_DIRS.join('、') + '（与镜像层同一份名单，**不读远程的 .gitignore**）。',
    parameters: {
      pattern: { type: 'string', required: true, description: '文件名 glob，例如 "**/*.ts"、"src/**/*.test.js"' },
      path: { type: 'string', description: '搜索目录，默认会话工作区（相对路径按它解析）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          paths: { type: 'array', required: true, items: { type: 'string' } },
          truncated: { type: 'boolean', required: true },
          partial: { type: 'boolean', required: true },
        },
      },
      // 渲染在 `render` 里做 —— 返回值必须**严格符合 schema**
      //（`additionalProperties: false` 时塞额外的 `text` 字段会被校验挡下）
      render: (_args, value) => [{
        type: 'text',
        text: renderGlobText(value.paths, value.root, value.truncated === true, value.partial === true),
      }],
    },
    async execute(args, exec) {
      const { source } = globToEre(args.pattern)
      const root = toRemote(args.path)
      const run = await runRemote(buildGlobCommand({ root, ere: source, cap }), exec?.signal)
      const { paths, truncated } = parseGlobOutput(run.stdout, cap)
      return { root, paths, truncated: truncated || run.truncated, partial: run.partial }
    },
  })), `${name}: glob`)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'grep',
    description:
      '按内容搜索文件（**在远程执行**：用远程的 grep -E，不受本地镜像边界影响）。' +
      '正则用 **POSIX 扩展正则语法**（不是 ripgrep 语法；rg 特有的写法不支持）。' +
      `返回匹配行与行号，最多 ${cap} 条。` +
      'include 支持简单 glob 与大括号（如 "*.ts"、"*.{js,jsx}"）。' +
      '已剪枝的目录：' + PRUNED_DIRS.join('、') + '。',
    parameters: {
      pattern: { type: 'string', required: true, description: 'POSIX 扩展正则（grep -E）' },
      path: { type: 'string', description: '要搜的文件或目录，默认会话工作区' },
      include: { type: 'string', description: '只看这些文件（简单 glob，如 "*.ts"）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
          partial: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderGrepText(value.matches, value.root, value.truncated === true, value.partial === true),
      }],
    },
    async execute(args, exec) {
      const root = toRemote(args.path)
      const run = await runRemote(
        buildGrepCommand({ root, pattern: String(args.pattern ?? ''), include: args.include, cap }),
        exec?.signal,
      )
      const { matches, truncated } = parseGrepOutput(run.stdout, cap)
      return { root, matches, truncated: truncated || run.truncated, partial: run.partial }
    },
  })), `${name}: grep`)
}
