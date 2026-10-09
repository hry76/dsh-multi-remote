/**
 * 锚点目录的 git 支撑。
 *
 * 为什么锚点必须是 git 仓库（实测结论，不是设计偏好）：
 *   宿主的「改动对比」是在 **`turn/start` → `agent/turn-stopping`** 两个时点对**会话 cwd**
 *   做 git 快照再 diff（`dsh-workspace-changes`：`rev-parse` → 临时 index `add --all`
 *   → `write-tree` → `diff-tree --numstat`）。它**不**监听文件变化。
 *   没有 git 仓库时，它只能列出「**文件工具**碰过的路径」——而我们的 agent 是在**远程**
 *   改文件，本地没有任何文件工具调用 → 改动对比永远是空的。
 *
 * 所以：锚点目录在建立镜像时就 `git init` 并提交一次基线；此后镜像的每次更新都表现为
 * 「未提交的改动」，正好是改动对比要展示的东西。
 *
 * 注意：这里**不引入任何 npm 依赖**，直接调用系统 `git`。宿主侧本来就用系统 git
 * （`dsh-workspace-changes` 走 `subprocess` 跑 `git`），所以这不是新增约束。
 */
import { execFile } from 'node:child_process'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 镜像仓库提交基线时用的身份。刻意不用 `--global`，避免污染用户配置。 */
const COMMITTER_NAME = 'dsh-multi-remote'
const COMMITTER_EMAIL = 'mirror@dsh-multi-remote.invalid'

/** 单条 git 命令的默认超时。 */
const DEFAULT_TIMEOUT_MS = 30_000

/** 写进锚点的 `.gitignore`：镜像自身的状态文件不参与对比。 */
const ANCHOR_GITIGNORE = [
  '# 由 dsh-multi-remote 生成：锚点目录是远程项目的只读镜像。',
  '# 这里的内容只是「照片」，真正的文件在远程机器上。',
  '#',
  '# 镜像自身的状态文件不参与改动对比。',
  '.dsh-multi-remote/',
  '',
].join('\n')

/** git 调用失败。带 `code`（退出码）、`stderr` 与原始命令，便于分类处理。 */
export class GitError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: number|null, stderr?: string, args?: string[], cwd?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'GitError'
    this.code = details.code ?? null
    this.stderr = details.stderr ?? ''
    this.args = details.args ?? []
    this.cwd = details.cwd ?? ''
  }
}

/**
 * 跑一条 git 命令。
 *
 * 环境被刻意收窄：关闭交互式提示与可选锁，并把 `GIT_CONFIG_COUNT` 清零 ——
 * 与宿主自己跑 git 的方式一致（`dsh-workspace-changes` 就是这么做的），
 * 避免用户的 `~/.gitconfig` 里的 includeIf / 凭据助手把命令挂住。
 *
 * @param {string[]} args
 * @param {{ cwd: string, timeoutMs?: number, allowExitCodes?: number[] }} options
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runGit(args, options) {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, allowExitCodes = [0] } = options
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_COUNT: '0',
        // 基线提交要显式带身份，避免依赖用户是否配过 user.name
        GIT_AUTHOR_NAME: COMMITTER_NAME,
        GIT_AUTHOR_EMAIL: COMMITTER_EMAIL,
        GIT_COMMITTER_NAME: COMMITTER_NAME,
        GIT_COMMITTER_EMAIL: COMMITTER_EMAIL,
      },
    }, (error, stdout, stderr) => {
      const code = error?.code ?? 0
      if (error !== null && error !== undefined && !allowExitCodes.includes(Number(code))) {
        reject(new GitError(`git ${args.join(' ')} 失败（退出码 ${code}）`, {
          code: Number(code),
          stderr: String(stderr ?? ''),
          args,
          cwd,
        }))
        return
      }
      resolve({ code: Number(code), stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/** 锚点目录是否已经是 git 仓库。 */
export async function isGitRepo(anchorPath) {
  try {
    const info = await stat(join(anchorPath, '.git'))
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}

/**
 * 确保锚点目录是一个可用的 git 仓库，并写好 `.gitignore`。
 *
 * 幂等：已经是仓库时只补 `.gitignore`，不重复 init、不改动已有配置。
 *
 * @param {string} anchorPath 锚点目录（会被创建）
 * @param {{ log?: (msg: string, ...rest: unknown[]) => void }} [options]
 * @returns {Promise<{ created: boolean, gitignoreWritten: boolean }>}
 */
export async function ensureAnchorRepo(anchorPath, options = {}) {
  const log = options.log
  await mkdir(anchorPath, { recursive: true })

  const gitignorePath = join(anchorPath, '.gitignore')
  let gitignoreWritten = false
  try {
    const existing = await stat(gitignorePath)
    if (!existing.isFile()) throw new Error('not a file')
  } catch {
    await writeFile(gitignorePath, ANCHOR_GITIGNORE, 'utf8')
    gitignoreWritten = true
  }

  const existed = await isGitRepo(anchorPath)
  if (!existed) {
    await runGit(['init', '--quiet'], { cwd: anchorPath })
    log?.('[mirror] 锚点已 git init：%s', anchorPath)
  }

  return { created: !existed, gitignoreWritten }
}

/**
 * 把当前工作区全部暂存并提交一次基线。
 *
 * 只在**建立镜像基线**时调用。此后镜像的更新**故意保持未提交**，
 * 这样宿主的改动对比才能把它们呈现为「本轮改动」。
 *
 * @param {string} anchorPath
 * @param {string} message
 * @param {{ allowEmpty?: boolean, log?: (msg: string, ...rest: unknown[]) => void }} [options]
 * @returns {Promise<{ committed: boolean, reason?: string, commit?: string }>}
 */
export async function commitBaseline(anchorPath, message, options = {}) {
  const log = options.log
  await runGit(['add', '--all', '--ignore-errors'], { cwd: anchorPath, allowExitCodes: [0, 1] })

  const staged = await runGit(['diff', '--cached', '--name-only'], { cwd: anchorPath })
  if (staged.stdout.trim() === '' && options.allowEmpty !== true) {
    return { committed: false, reason: 'nothing-to-commit' }
  }

  const args = ['commit', '--quiet', '--no-verify', '-m', message]
  if (options.allowEmpty === true) args.push('--allow-empty')
  await runGit(args, { cwd: anchorPath, allowExitCodes: [0, 1] })

  const head = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: anchorPath })
  log?.('[mirror] 锚点基线已提交：%s', head.stdout.trim())
  return { committed: true, commit: head.stdout.trim() }
}

/**
 * 读锚点当前的改动概览 —— 与宿主改动对比**同一读法**，用于自检。
 *
 * @param {string} anchorPath
 * @returns {Promise<{ porcelain: string, numstat: string, isRepo: boolean }>}
 */
export async function readAnchorChanges(anchorPath) {
  if (!(await isGitRepo(anchorPath))) {
    return { porcelain: '', numstat: '', isRepo: false }
  }
  const porcelain = await runGit(['status', '--porcelain'], { cwd: anchorPath })
  const numstat = await runGit(['diff', '--numstat', 'HEAD'], { cwd: anchorPath, allowExitCodes: [0, 128] })
  return { porcelain: porcelain.stdout.trim(), numstat: numstat.stdout.trim(), isRepo: true }
}

/** 锚点的 `.gitignore` 内容（供测试与诊断使用）。 */
export const ANCHOR_GITIGNORE_CONTENT = ANCHOR_GITIGNORE
