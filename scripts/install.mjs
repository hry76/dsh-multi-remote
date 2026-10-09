#!/usr/bin/env node
/**
 * 安装器 —— 让「装上了」和「真的被加载」变成同一件事。
 *
 * ## 它解决什么（真实失败模式，已实测复现）
 *
 * pnpm 11+ 默认拒绝任何「没提前表态」的依赖构建脚本，并且**以非零退出码失败**：
 *
 * ```
 * [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: cpu-features@0.0.10, ssh2@1.17.0
 * Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
 * dsh: plugin command failed
 * ```
 *
 * 而 `dsh plugin` **只在安装成功时才把插件登记进 `dsh.profile.bundles`**。结果：
 *
 * ```
 * node_modules/@jk-uzi/dsh-multi-remote  ← 装上了
 * dsh.profile.bundles                    ← 没有它 → 永远不加载，且没有任何提示
 * ```
 *
 * 这就是「包装了但从不加载」。本安装器把三件事按顺序做完：
 *
 *   1. **先表态**：往用户 profile 的 `pnpm-workspace.yaml` 写入构建脚本决定
 *   2. **再安装**：调用 `dsh plugin --profile <p> add <目标>`
 *   3. **后校验**：回读 `dsh.profile.bundles`，确认插件**真的被登记**；没登记就非零退出
 *
 * ## 构建脚本的决定
 *
 * `ssh2` 与 `cpu-features` 都**拒绝构建（false）**：
 *   - `ssh2` 是纯 JS 实现，构建脚本只做可选原生加速的准备 —— **不构建不影响功能**
 *     （已实测：能连接、能 exec、能 SFTP）
 *   - `cpu-features` 需要 C++ 工具链。允许它会让**没有编译环境的用户直接装不上**，
 *     换来的只是一点特性探测。不值得。
 *
 * 所以本插件**零原生依赖**。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/install.mjs --profile dev                    # 从 npm 装
 * node scripts/install.mjs --profile dev --target .         # 从本地目录装（开发）
 * node scripts/install.mjs --profile dev --target link:.    # 软链挂载（开发，改代码即生效）
 * ```
 *
 * 幂等：重复执行不会重复写入表态；已登记的插件会被识别出来。
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, dirname, normalize } from 'node:path'

/** 本包名。 */
const PACKAGE_NAME = '@jk-uzi/dsh-multi-remote'

/** 需要显式表态的构建脚本（全部拒绝，理由见文件头）。 */
const BUILD_SCRIPT_DECISIONS = {
  ssh2: false,
  'cpu-features': false,
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const options = { profile: 'default', target: PACKAGE_NAME, dshHome: undefined, bin: 'dsh', dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一个值`)
      i += 1
      return value
    }
    if (arg === '--profile') options.profile = next()
    else if (arg === '--target') options.target = next()
    else if (arg === '--dsh-home') options.dshHome = next()
    else if (arg === '--bin') options.bin = next()
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

const HELP = `用法：node scripts/install.mjs [选项]

  --profile <名>     DSH profile 名（默认 default）
  --target <目标>    要安装的目标：npm 包名 / 本地目录 / link:<目录>（默认 ${PACKAGE_NAME}）
  --dsh-home <目录>  DSH_HOME（默认取环境变量 DSH_HOME，再退回 ~/.dsh）
  --bin <路径>       dsh 可执行文件（默认 dsh，需在 PATH 里）
  --dry-run          只显示要做什么，不真的执行
  -h, --help         显示本帮助

例：
  node scripts/install.mjs --profile dev
  node scripts/install.mjs --profile dev --target link:.     # 开发：软链挂载
`

/**
 * 跑一个外部命令，返回 `{ code, stdout, stderr }`。
 *
 * Windows 上有个坑：Node 18.20+/20.12+/22+ 出于安全考虑**不再允许直接 spawn
 * `.cmd` / `.bat`**（会抛 `EINVAL`），而 DSH Desktop 的 CLI 恰好就是 `dsh.cmd`。
 *
 * 处理顺序：
 *   1. `.cmd` / `.bat` → 先试着解析成真正的 exe + 脚本，**完全绕开 shell**
 *      （这样路径里的空格与引号嵌套都不再是问题）
 *   2. 解析不出来 → 退回 `shell: true`（并给参数加引号）
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, env?: Record<string,string> }} [options]
 */
async function run(command, args, options = {}) {
  let spawnCommand = command
  let spawnArgs = args
  let extraEnv = {}
  let useShell = false

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const shim = await resolveBatchShim(command)
    if (shim !== undefined) {
      spawnCommand = shim.command
      spawnArgs = [...shim.prefixArgs, ...args]
      extraEnv = shim.env
    } else {
      useShell = true
      spawnArgs = args.map((arg) => quoteForShell(arg))
    }
  }

  return new Promise((resolvePromise) => {
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: options.cwd,
      windowsHide: true,
      shell: useShell,
      env: { ...process.env, ...extraEnv, ...options.env },
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutMs ?? 300_000)
    // 注意：**不 unref** —— 这是唯一的结算定时器，unref 掉会让进程提前退出

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: 1, stdout, stderr: `${stderr}${error?.message ?? error}\n`, error })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({
        code: timedOut ? 124 : Number(code ?? 0),
        stdout,
        stderr: timedOut ? `${stderr}（命令超时被杀）\n` : stderr,
        error: undefined,
      })
    })
  })
}

/** shell 兜底路径用的参数引号（只在不走解析时才用到）。 */
function quoteForShell(value) {
  const text = String(value)
  if (text === '') return '""'
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
}
/**
 * 试着把 `dsh.cmd` 这类批处理壳**解析成真正的可执行文件 + 脚本**，
 * 这样就不必经过 shell —— Windows 上的引号嵌套问题直接消失。
 *
 * 实测 DSH Desktop 的 `dsh.cmd` 长这样：
 * ```
 * set "ELECTRON_RUN_AS_NODE=1"
 * "<...>\DeepSeek Harness.exe" --expose-internals "<...>\dsh-desktop-host\lib\cli.js" %*
 * ```
 * 里面带空格的可执行文件路径是**有引号**的，正好能可靠地切出来。
 *
 * @param {string} cmdPath
 * @returns {Promise<{ command: string, prefixArgs: string[], env: Record<string,string> }|undefined>}
 */
async function resolveBatchShim(cmdPath) {
  let text
  try {
    text = await readFile(cmdPath, 'utf8')
  } catch {
    return undefined
  }

  // `%~dp0` 是批处理里「本脚本所在目录（带尾反斜杠）」的写法，必须先展开，
  // 否则会得到一个字面量路径 `%~dp0..\..\..\..\X.exe` → spawn ENOENT。
  const shimDir = dirname(resolve(cmdPath))
  const expand = (value) => value
    .replace(/%~dp0/gi, `${shimDir}\\`)
    .replace(/%CD%/gi, process.cwd())

  const env = {}
  for (const match of text.matchAll(/set\s+"?([A-Za-z_][A-Za-z0-9_]*)=([^"\r\n]*)"?/g)) {
    env[match[1]] = expand(match[2].trim())
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || /^@?echo\b/i.test(line) || /^setlocal\b/i.test(line) || /^set\b/i.test(line) || /^exit\b/i.test(line) || /^rem\b/i.test(line)) {
      continue
    }
    // 形如： "%~dp0..\..\X.exe" --flag "%~dp0..\cli.js" %*
    const match = /^"([^"]+)"\s*(.*)$/.exec(line)
    if (match === null) continue
    const command = normalize(expand(match[1]))
    if (!/\.exe$/i.test(command)) continue

    const rest = expand(match[2].replace(/%\*.*$/, '')).trim()
    const prefixArgs = []
    for (const argMatch of rest.matchAll(/"([^"]+)"|(\S+)/g)) {
      const value = argMatch[1] ?? argMatch[2]
      if (value !== undefined && value !== '') prefixArgs.push(value)
    }
    return { command, prefixArgs, env }
  }
  return undefined
}

/** 确定 DSH_HOME。 */
function resolveDshHome(explicit) {
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '') return resolve(process.env.DSH_HOME)
  return join(homedir(), '.dsh')
}

/**
 * 判断某个 `allowBuilds` 条目的值是不是 **pnpm 生成的占位符**。
 *
 * pnpm 在拒绝构建时会把占位文本写进配置：
 * ```
 * allowBuilds:
 *   ssh2: set this to true or false
 * ```
 * 这种值 pnpm 自己**不认**（它要求 true/false），所以留着等于没表态，
 * 下一次安装仍然会以 `ERR_PNPM_IGNORED_BUILDS` 失败。
 * 所以「已存在的键不覆盖」这条规则要有一个例外：占位符必须被改写。
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isPlaceholderDecision(value) {
  const text = String(value ?? '').trim()
  if (text === '') return true
  if (text === 'true' || text === 'false') return false
  // pnpm 的占位文案
  if (/set this to (true|false)/i.test(text)) return true
  // 其他非布尔值一律视为「没做出有效决定」
  return !/^(true|false)$/.test(text)
}

/**
 * 把一个 `键: 值` 表态合并进 pnpm-workspace.yaml。
 *
 * **逐行处理，不解析再重写整个 YAML** —— 用户的这个文件里可能有注释、
 * 其他字段（例如 `nodeLinker`、`packages`），重写会把它们弄丢。
 *
 * @param {string} text 现有内容
 * @param {Record<string, boolean>} decisions
 * @returns {{ text: string, added: string[], kept: string[], replaced: string[] }}
 */
export function mergeAllowBuilds(text, decisions) {
  const lines = String(text ?? '').split(/\r?\n/)
  const added = []
  const kept = []
  const replaced = []

  // 先看有没有 allowBuilds 段
  let blockStart = -1
  let blockEnd = lines.length
  for (let i = 0; i < lines.length; i += 1) {
    if (/^allowBuilds\s*:/.test(lines[i])) {
      blockStart = i
      for (let j = i + 1; j < lines.length; j += 1) {
        if (/^\S/.test(lines[j]) && lines[j].trim() !== '') {
          blockEnd = j
          break
        }
      }
      break
    }
  }

  if (blockStart === -1) {
    // 没有这个段：追加到末尾（保持原内容一字不动）
    const prefix = lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
    const block = ['', '# 由 dsh-multi-remote 安装器写入：显式拒绝原生构建（见插件文档）', 'allowBuilds:', ...Object.entries(decisions).map(([name, value]) => `  ${name}: ${value}`)]
    return { text: [...prefix, ...block, ''].join('\n'), added: Object.keys(decisions), kept, replaced }
  }

  // 有：逐条处理。已存在且是**有效**决定的不覆盖；占位符要改写。
  const existing = new Map()
  for (let i = blockStart + 1; i < blockEnd; i += 1) {
    const match = /^(\s+)([A-Za-z0-9@/._-]+)\s*:\s*(.*)$/.exec(lines[i])
    if (match !== null) existing.set(match[2], { line: i, indent: match[1], rawValue: match[3] })
  }

  const toAppend = []
  for (const [name, value] of Object.entries(decisions)) {
    const found = existing.get(name)
    if (found === undefined) {
      toAppend.push(`  ${name}: ${value}`)
      added.push(name)
      continue
    }
    if (isPlaceholderDecision(found.rawValue)) {
      // 占位符：改写成本插件的决定（这是唯一「覆盖已有键」的正当理由）
      lines[found.line] = `${found.indent}${name}: ${value}`
      replaced.push(name)
      continue
    }
    kept.push(name)
  }

  if (toAppend.length === 0) return { text: lines.join('\n'), added, kept, replaced }

  const merged = [...lines.slice(0, blockEnd), ...toAppend, ...lines.slice(blockEnd)]
  return { text: merged.join('\n'), added, kept, replaced }
}

/** 读 profile 的 bundle 列表。 */
export async function readBundles(profileDir) {
  try {
    const parsed = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    const bundles = parsed?.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles : []
  } catch {
    return []
  }
}

/**
 * 判断一个已安装的包是否声明了 `dsh.bundle`（也就是「它是一个 profile 层」）。
 *
 * 只有声明了的包才应该进 `dsh.profile.bundles` —— 否则会往 bundle 栈里塞一个
 * 不提供任何层的包，启动时报错。
 *
 * @param {string} profileDir
 * @param {string} packageName
 * @returns {Promise<boolean>}
 */
export async function declaresBundle(profileDir, packageName) {
  try {
    const manifestPath = join(profileDir, 'node_modules', packageName, 'package.json')
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
    return parsed?.dsh?.bundle !== undefined
  } catch {
    return false
  }
}

/**
 * 把插件登记进 profile 的 `dsh.profile.bundles`。
 *
 * ## 为什么安装器要自己干这件事
 *
 * 实测：从 tarball / npm 包安装时，`dsh plugin add` 会把包写进 `dependencies`，
 * 但**不会**把它加进 `dsh.profile.bundles`。而 profile 启动时是按 bundles 组装的 ——
 * 结果就是「装上了但从不加载，且没有任何提示」。
 *
 * 这一步是**纯增量**的：只往数组里加一个名字，不动其他任何字段；
 * 已经在里面就原样返回（幂等）。
 *
 * @param {string} profileDir
 * @param {string} packageName
 * @returns {Promise<{ changed: boolean, bundles: string[] }>}
 */
export async function ensureBundleRegistered(profileDir, packageName) {
  const manifestPath = join(profileDir, 'package.json')
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8'))

  parsed.dsh ??= {}
  parsed.dsh.profile ??= {}
  const bundles = Array.isArray(parsed.dsh.profile.bundles) ? parsed.dsh.profile.bundles : []
  if (bundles.includes(packageName)) return { changed: false, bundles }

  parsed.dsh.profile.bundles = [...bundles, packageName]
  // 保留原有缩进风格（profile 文件是 2 空格）
  await writeFile(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return { changed: true, bundles: parsed.dsh.profile.bundles }
}

/** 主流程。 */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    process.stdout.write(HELP)
    return 0
  }

  const dshHome = resolveDshHome(options.dshHome)
  const profileDir = join(dshHome, 'profiles', options.profile)
  const workspaceFile = join(profileDir, 'pnpm-workspace.yaml')

  process.stdout.write(`dsh-multi-remote 安装器\n`)
  process.stdout.write(`  DSH_HOME : ${dshHome}\n`)
  process.stdout.write(`  profile  : ${options.profile}\n`)
  process.stdout.write(`  target   : ${options.target}\n\n`)

  // ── 0. profile 必须已存在 ──────────────────────────────────────────────
  try {
    const info = await stat(profileDir)
    if (!info.isDirectory()) throw new Error('not a directory')
  } catch {
    process.stderr.write(
      `找不到 profile 目录：${profileDir}\n` +
      `先建一个（示例）：\n` +
      `  dsh --profile ${options.profile} --from-default-profile web --dump-config\n`,
    )
    return 1
  }

  // ── 1. 先表态：写构建脚本决定 ──────────────────────────────────────────
  let existing = ''
  try {
    existing = await readFile(workspaceFile, 'utf8')
  } catch {
    existing = ''
  }
  const merged = mergeAllowBuilds(existing, BUILD_SCRIPT_DECISIONS)
  if (merged.added.length > 0 || merged.replaced.length > 0) {
    if (options.dryRun) {
      process.stdout.write(`[dry-run] 会写入 ${workspaceFile}：\n${merged.text}\n`)
    } else {
      await mkdir(profileDir, { recursive: true })
      await writeFile(workspaceFile, merged.text, 'utf8')
      if (merged.added.length > 0) {
        process.stdout.write(`✓ 已写入构建脚本表态：${merged.added.join(', ')} → 全部拒绝（本插件零原生依赖）\n`)
      }
      if (merged.replaced.length > 0) {
        process.stdout.write(`✓ 已把 pnpm 的占位符改写为明确决定：${merged.replaced.join(', ')}\n`)
      }
    }
  } else {
    process.stdout.write(`✓ 构建脚本表态已存在且有效，保持不变\n`)
  }
  if (merged.kept.length > 0) {
    process.stdout.write(`  （保留用户已有决定：${merged.kept.join(', ')}）\n`)
  }

  // ── 2. 安装 ────────────────────────────────────────────────────────────
  const before = await readBundles(profileDir)
  const installArgs = ['plugin', '--profile', options.profile, 'add', options.target]
  process.stdout.write(`\n→ ${options.bin} ${installArgs.join(' ')}\n`)
  if (options.dryRun) {
    process.stdout.write('[dry-run] 跳过实际安装\n')
    return 0
  }

  const installed = await run(options.bin, installArgs)
  if (installed.stdout.trim() !== '') process.stdout.write(installed.stdout)
  if (installed.stderr.trim() !== '') process.stderr.write(installed.stderr)

  if (installed.code !== 0) {
    process.stderr.write(
      `\n✗ 安装命令以非零退出码结束（${installed.code}）。\n` +
      `  常见原因与对策：\n` +
      `    ERR_PNPM_IGNORED_BUILDS → 表态没写进去；确认 ${workspaceFile} 里有 allowBuilds\n` +
      `    ERR_PNPM_EPERM          → 上一次的 link 残留（Windows junction）挡住了；\n` +
      `                              删掉 <profile>/node_modules 后重试\n`,
    )
    return 1
  }

  // ── 3. 后校验：插件真的被登记了吗 ──────────────────────────────────────
  // 这一步是整个安装器存在的理由：安装命令成功 ≠ 插件会被加载。
  let after = await readBundles(profileDir)

  if (!after.includes(PACKAGE_NAME)) {
    // 自愈：实测 `dsh plugin add` 从 tarball/npm 包安装时**只写 dependencies、
    // 不写 dsh.profile.bundles** —— 而 profile 启动是按 bundles 组装的。
    // 只在包确实声明了 dsh.bundle 时才补登记，避免往 bundle 栈里塞非层包。
    const isBundle = await declaresBundle(profileDir, PACKAGE_NAME)
    if (isBundle) {
      const healed = await ensureBundleRegistered(profileDir, PACKAGE_NAME)
      after = healed.bundles
      process.stdout.write(
        `\n! dsh plugin add 没有把它加进 dsh.profile.bundles（实测行为）。\n` +
        `  安装器已补登记：${PACKAGE_NAME}\n` +
        `  —— 不做这一步的话，插件会被装进 node_modules 但**永远不加载**。\n`,
      )
    } else {
      process.stderr.write(
        `\n✗ 安装成功，但 ${PACKAGE_NAME} 既没有出现在 dsh.profile.bundles 里，\n` +
        `  也没有声明 dsh.bundle —— 它不会作为 profile 层被加载。\n`,
      )
      return 1
    }
  }

  const added = after.filter((name) => !before.includes(name))
  const registered = after.includes(PACKAGE_NAME)

  if (registered) {
    process.stdout.write(
      `\n✓ 安装完成，且已确认登记进 dsh.profile.bundles\n` +
      `  bundles: ${after.join(', ')}\n` +
      (added.length > 0 ? `  本次新增：${added.join(', ')}\n` : '') +
      `\n下一步：重启该 profile 让插件生效，然后自检：\n` +
      `  dsh --profile ${options.profile} --no-open\n` +
      `  # GET http://127.0.0.1:<port>/multi-remote/selfcheck\n`,
    )
    return 0
  }

  process.stderr.write(
    `\n✗ 安装命令成功了，但 ${PACKAGE_NAME} **没有**出现在 dsh.profile.bundles 里。\n` +
    `  这正是「包装了但从不加载」的失败模式 —— 插件不会生效，而且没有任何提示。\n` +
    `  当前 bundles：${after.join(', ') || '(空)'}\n\n` +
    `  请检查：\n` +
    `    1. ${join(profileDir, 'package.json')} 里有没有它\n` +
    `    2. 手动补一行到 dsh.profile.bundles，然后重启 profile\n`,
  )
  return 1
}

// 只有在直接执行时才跑主流程（被 import 时不跑，便于单测 mergeAllowBuilds）
const isDirectRun = process.argv[1] !== undefined
  && (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
    || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')))

if (isDirectRun) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      process.stderr.write(`安装器失败：${error?.stack ?? error}\n`)
      process.exitCode = 1
    },
  )
}

export { main, parseArgs, resolveDshHome, BUILD_SCRIPT_DECISIONS, PACKAGE_NAME }