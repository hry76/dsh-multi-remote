/**
 * 连接前校验「远程项目根」是否存在。
 *
 * ## 为什么必须有这一步（真机事故）
 *
 * 2026-10-07：用户把远程根填成了 `/home/user/新建文件夹`，而那个目录在远程
 * **根本不存在**（真实位置是 `/home/user/桌面/新建文件夹`）。
 *
 * 结果：**连接成功**，但之后每一条命令都先 `cd` 到不存在的目录 → 失败，
 * 而且报错是一句含糊的 `cd: ... No such file or directory`。
 * 用户和模型都花了很久才反应过来「是路径填错了」，中间还怀疑是插件坏了。
 *
 * **这属于我们的责任**：路径是用户在界面上填的，我们就该当场验证 ——
 * 而不是让他连上之后在几十条命令的失败里猜。
 * 这与项目的硬约束一致：**不静默降级、失败要说得清**。
 *
 * ## 一次往返拿到三件事
 *
 * 1. 目录在不在（不在还要区分「不存在」和「存在但不是目录」）
 * 2. 父目录在不在（父目录都不在，说明整条路径都写错了）
 * 3. **同名目录的建议**：在父目录下最多 3 层找同名的目录 ——
 *    用户的情况就是「少写了一层 `桌面/`」，这条建议直接给出答案
 */
import { shellQuote } from '../terminal/quote.js'

/**
 * 探测命令里的标记。**测试替身**（假传输层）用它识别这条命令 ——
 * 否则假机器答不出「目录存在」，连接会被正确拦下，测试反而挂了。
 */
export const ROOT_CHECK_MARKER = 'DSH-MR-ROOT-CHECK'

/**
 * 构造校验命令。
 *
 * 路径用 `shellQuote` 内联（而不是走参数）—— 传输层的脚本参数机制各家不同，
 * 内联最省事且没有歧义。路径里带空格、中文、引号都能正确处理。
 *
 * 输出格式（逐行）：
 *   `OK`            —— 目录存在，可以用
 *   `NOTDIR`        —— 路径存在但不是目录（是个文件？）
 *   `MISSING`       —— 不存在
 *   之后的行        —— 建议的同名目录（可能没有）
 *
 * @param {string} root
 * @returns {string}
 */
export function buildRootCheckCommand(root) {
  const quoted = shellQuote(root)
  return [
    // 标记行：测试替身靠它认出「这是在探测远程根」，从而如实回答。
    // （不用「命令里包含 MISSING」这种脆弱匹配 —— 改一个字就失效。）
    `# ${ROOT_CHECK_MARKER}`,
    `root=${quoted}`,
    'if [ -d "$root" ]; then echo OK; exit 0; fi',
    'if [ -e "$root" ] || [ -L "$root" ]; then echo NOTDIR; exit 0; fi',
    'echo MISSING',
    // 父目录在不在：不在的话连「找同名目录」都没意义
    'parent=$(dirname -- "$root")',
    'base=$(basename -- "$root")',
    'if [ -d "$parent" ]; then echo PARENT_OK; else echo PARENT_MISSING; fi',
    // 建议：父目录下最多 3 层找同名目录（用户就是少写了一层）
    'if [ -d "$parent" ] && [ "$base" != "/" ] && [ -n "$base" ]; then',
    '  find -- "$parent" -maxdepth 3 -type d -name "$base" 2>/dev/null | head -n 5',
    'fi',
    'exit 0',
  ].join('\n')
}

/**
 * 解析校验输出。
 *
 * @param {string} stdout
 * @returns {{ status: 'ok'|'notdir'|'missing', parentExists: boolean, candidates: string[] }}
 */
export function parseRootCheck(stdout) {
  const lines = String(stdout ?? '')
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line !== '')

  const status = lines.includes('OK') ? 'ok' : lines.includes('NOTDIR') ? 'notdir' : 'missing'
  const parentExists = lines.includes('PARENT_OK')
  const candidates = lines.filter((line) => line !== 'OK' && line !== 'NOTDIR' && line !== 'MISSING' && line !== 'PARENT_OK' && line !== 'PARENT_MISSING')

  return { status, parentExists, candidates }
}

/**
 * 校验远程根；不合法就抛**能照着做**的错误。
 *
 * @param {import('../transport/transport.js').Transport} transport 已连接的传输层
 * @param {string} root
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ status: 'ok', candidates: string[] }>}
 */
export async function verifyRemoteRoot(transport, root, options = {}) {
  const run = await transport.exec(buildRootCheckCommand(root), { signal: options.signal })
  const parsed = parseRootCheck(run?.stdout)

  if (parsed.status === 'ok') return { status: 'ok', candidates: parsed.candidates }

  const hint = parsed.candidates.length > 0
    ? `\n这台机器上找到同名目录：\n${parsed.candidates.map((path) => `  ${path}`).join('\n')}\n如果你要连的是其中之一，请用它重连。`
    : parsed.parentExists
      ? '\n（这台机器上没有找到同名的目录 —— 请确认路径拼写。）'
      : '\n（连上级目录都不存在 —— 整条路径可能都写错了。）'

  const what = parsed.status === 'notdir'
    ? `远程路径不是一个目录：${root}`
    : `远程目录不存在：${root}`

  const error = new Error(
    `${what}\n` +
    '这个工作区里的每条命令都会先切到这个目录，所以现在连上也用不了。\n' +
    hint +
    `\n如果这是新目录，请先在远程创建：mkdir -p ${shellQuote(root)}`,
  )
  error.code = 'REMOTE_ROOT_MISSING'
  error.remoteRoot = root
  error.candidates = parsed.candidates
  throw error
}
