#!/usr/bin/env node
/**
 * 从宿主的默认预设里**同步**「计划模式提示词段」。
 *
 * ## 为什么需要这个脚本
 *
 * `@deepseek-ai/dsh-plan-mode` 需要一个非空的 `section` 配置，否则该行进入
 * `broken` —— 而**一行 broken 会让整个预设激活失败**（实测报
 * `PlanModeConfig needs a non-empty \`section\``）。
 *
 * 那段文本是**宿主自己那份默认预设的配置值**（不是第三方代码），
 * 逐字保持一致才能让「远程会话的计划模式」与「本地会话」行为完全相同。
 * 手抄容易出错、也会随宿主升级而过时，所以从宿主的 preset 文件生成。
 *
 * ## 用法
 *
 *   node scripts/sync-plan-mode-section.mjs <ptc.patch.yml 的路径>
 *
 * 路径在哪：DSH 安装目录下
 *   `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`
 *
 * （asar 里的文件可以直接按路径读 —— Electron 的 fs 补丁让 `app.asar` 表现为目录。
 *   用普通 Node 读不到时，可以用 `npx asar extract` 或把该文件复制出来。）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEST = join(HERE, '..', 'src', 'session', 'plan-mode-section.js')

const source = process.argv[2]
if (source === undefined) {
  console.error('用法：node scripts/sync-plan-mode-section.mjs <ptc.patch.yml 的路径>')
  process.exit(2)
}

/**
 * 从 YAML 里抠出 `section: |` 那个**字面块**。
 *
 * 只做这一件事，所以没用 YAML 库 —— 也符合本项目「零运行时依赖」的取向
 * （脚本用的是 Node 内置能力）。
 */
function extractLiteralBlock(text, key = 'section') {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => new RegExp(`^\\s*${key}:\\s*\\|`).test(line))
  if (start < 0) throw new Error(`找不到 ${key}: |`)

  const keyIndent = lines[start].length - lines[start].trimStart().length
  const body = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') {
      body.push('')
      continue
    }
    const indent = line.length - line.trimStart().length
    if (indent <= keyIndent) break
    body.push(line)
  }

  // 去掉块自身的缩进（以第一条非空行为基准）
  const first = body.find((line) => line.trim() !== '')
  if (first === undefined) throw new Error(`${key} 块是空的`)
  const base = first.length - first.trimStart().length
  return body
    .map((line) => (line.trim() === '' ? '' : line.slice(base)))
    .join('\n')
    .replace(/\s+$/, '')
}

/** 把文本安全地放进模板字面量。 */
function asTemplateLiteral(text) {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

const section = extractLiteralBlock(readFileSync(source, 'utf8'))

const header = `/**
 * 计划模式（plan mode）的提示词段 —— **逐字取自宿主的默认预设**。
 *
 * ## 为什么是「逐字用宿主那份配置」
 *
 * 这不是参考项目的代码，而是**宿主自己那份默认预设的配置值**
 * （宿主安装目录下 \`@deepseek-ai/dsh-web-app/presets/ptc.patch.yml\` 里
 * \`plan-mode\` 行的 \`section\`）。\`@deepseek-ai/dsh-plan-mode\` 要求它非空，
 * 否则该行进入 \`broken\` —— 而**一行 broken 会让整个预设激活失败**
 * （实测：\`PlanModeConfig needs a non-empty \\\`section\\\`\`，我们的 fail-loud
 * 会因此直接拒绝建立连接）。
 *
 * 逐字保持一致的理由：**远程会话的计划模式应当与本地会话行为完全一样**。
 * 自己另写一版会让两边的规则悄悄分叉。
 *
 * ⚠️ **不要手改这个文件** —— 由 \`scripts/sync-plan-mode-section.mjs\` 生成。
 *
 *     node scripts/sync-plan-mode-section.mjs <宿主里的 ptc.patch.yml>
 *
 * 宿主升级后这份文本可能变；变了也只是提示词措辞差异，不影响功能。
 */
export const PLAN_MODE_SECTION = \``

writeFileSync(DEST, `${header}${asTemplateLiteral(section)}\`\n`, 'utf8')
console.log(`已写入 ${DEST}（${section.length} 字符）`)
