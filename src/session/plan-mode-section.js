/**
 * 计划模式（plan mode）的提示词段 —— **逐字取自宿主的默认预设**。
 *
 * ## 为什么是「逐字用宿主那份配置」
 *
 * 这不是参考项目的代码，而是**宿主自己那份默认预设的配置值**
 * （宿主安装目录下 `@deepseek-ai/dsh-web-app/presets/ptc.patch.yml` 里
 * `plan-mode` 行的 `section`）。`@deepseek-ai/dsh-plan-mode` 要求它非空，
 * 否则该行进入 `broken` —— 而**一行 broken 会让整个预设激活失败**
 * （实测：`PlanModeConfig needs a non-empty \`section\``，我们的 fail-loud
 * 会因此直接拒绝建立连接）。
 *
 * 逐字保持一致的理由：**远程会话的计划模式应当与本地会话行为完全一样**。
 * 自己另写一版会让两边的规则悄悄分叉。
 *
 * ⚠️ **不要手改这个文件** —— 由 `scripts/sync-plan-mode-section.mjs` 生成。
 *
 *     node scripts/sync-plan-mode-section.mjs <宿主里的 ptc.patch.yml>
 *
 * 宿主升级后这份文本可能变；变了也只是提示词措辞差异，不影响功能。
 */
export const PLAN_MODE_SECTION = `You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`
