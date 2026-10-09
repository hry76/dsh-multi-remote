/**
 * 会话绑定 —— 抓住「会话刚创建、第一轮还没开始」那个窗口，把远程预设挂上去。
 *
 * ## 为什么必须挂在这个窗口上（时机约束）
 *
 * 预设**只能在会话开始第一轮之前选定**：之后 `agentPresets.select()` 抛
 * `agent-preset/locked`（实测）。所以用户流程被钉死成：
 *
 * ```
 * 先选远程工作区（= 锚点目录）→ 再建会话 → 会话自动用上我们的预设   ✅
 * 先建会话 → 再连远程                                              ❌ 换不了
 * ```
 *
 * ## 两个钩子，缺一不可
 *
 * | 钩子 | 干什么 | 为什么不能少 |
 * |---|---|---|
 * | `agent/created` | 异步做预设切换 | 宿主的 `agent/created` 监听器是**串行**的，且在创建完成前 await，正好把切换做完 |
 * | `agent/pre-step` | 等待在途切换，并**检查是否失败** | 只 await「在途切换」不够：切换失败后它已经结算，第一步会照跑 —— 那就是「静默在本机跑」 |
 *
 * 第二条尤其关键：参考项目就是只 await 在途状态，切换失败后第一步仍然在本机执行。
 * 这里改成**检查最终状态**：切换没成功就拒绝这一步。
 */
import { PRESET_ID } from './preset.js'

/** 绑定失败的分类。 */
export const BIND_STATUS = {
  /** 不是远程会话（cwd 不在任何锚点上）—— 正常情况，什么都不做。 */
  NOT_REMOTE: 'not-remote',
  /** 已绑定。 */
  BOUND: 'bound',
  /** 绑定失败 —— 必须拒绝会话继续，绝不回退本机。 */
  FAILED: 'failed',
}

/**
 * 把会话绑定到远程工作区。
 *
 * @param {object} options
 * @param {import('./connection.js').ConnectionManager} options.connections
 * @param {import('./preset.js').PresetRegistry} options.presetRegistry
 * @param {object} options.agentPresets 宿主服务
 * @param {(message: string, ...rest: unknown[]) => void} [options.log]
 */
export class SessionBinder {
  constructor(options) {
    this.connections = options.connections
    this.presetRegistry = options.presetRegistry
    this.agentPresets = options.agentPresets
    this.log = options.log

    /**
     * 每个 agent 的绑定状态。
     * `settled` 是「切换已经结束」的 Promise，`pre-step` 靠它判断能不能放行。
     * @type {Map<string, { promise: Promise<object>, settled: object|undefined }>}
     */
    this.bindings = new Map()
  }

  /**
   * 安装两个钩子。返回清理函数。
   *
   * @param {object} ctx 插件上下文
   * @returns {() => void}
   */
  install(ctx) {
    const disposers = []

    disposers.push(ctx.on('agent/created', async ({ agent }) => {
      // 宿主的 agent/created 是串行监听：在这里 await 会挡住「创建完成」，
      // 正好保证第一步之前切换已经做完。
      await this.#bind(agent)
    }))

    disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
      const agent = payload?.agent
      if (agent === undefined) return next()
      const binding = this.bindings.get(agent.id)
      if (binding === undefined) return next()

      // 等切换结束（可能还在途），再检查最终状态
      const outcome = await binding.promise
      if (outcome.status === BIND_STATUS.FAILED) {
        // **拒绝这一步**，而不是让它在本机跑。
        this.log?.('[session] 拒绝会话 %s 的步骤：远程绑定失败（%s）', agent.id, outcome.error)
        return {
          kind: 'reject',
          reason:
            `这个会话属于远程工作区，但远程预设没有挂上（${outcome.error}）。` +
            '为避免命令与文件操作静默落在本机，这一步被拒绝。' +
            '请检查连接是否仍然有效，然后重新建立会话。',
        }
      }
      return next()
    }))

    return () => {
      for (const dispose of disposers) dispose?.()
      this.bindings.clear()
    }
  }

  /**
   * 内部：真正做绑定。
   *
   * @param {object} agent
   * @returns {Promise<object>} 绑定结果
   */
  async #bind(agent) {
    const cwd = agent?.session?.header?.cwd
    const workspace = this.connections.findByAnchor(cwd)

    if (workspace === undefined) {
      // 不是远程会话：本地会话必须**完全不受影响**
      const outcome = { status: BIND_STATUS.NOT_REMOTE, cwd: cwd ?? null }
      this.bindings.set(agent.id, { promise: Promise.resolve(outcome), settled: outcome })
      return outcome
    }

    const promise = (async () => {
      try {
        // 幂等判断必须问「**这个 agent 身上**生效的是哪个预设」，
        // 而不是问「注册表里有没有这个预设」—— 后者永远为真（我们刚注册过），
        // 会让 select 永远不被调用，会话静默用着默认预设在本机跑。
        const effectiveBefore = this.agentPresets.composedPreset(agent.ctx)
        if (effectiveBefore === workspace.presetId) {
          return { status: BIND_STATUS.BOUND, presetId: workspace.presetId, alreadyBound: true }
        }

        // 切换（这一步会抛 agent-preset/locked —— 那时说明用户流程走反了）
        await this.agentPresets.select(agent, workspace.presetId)

        // **回读确认**：select() 返回成功不等于域内真的挂上了。
        // 参考项目从不回读，所以它的失败是静默的。
        const diagnostic = await this.presetRegistry.verify(workspace.presetId)
        if (!diagnostic.usable) {
          const outcome = {
            status: BIND_STATUS.FAILED,
            presetId: workspace.presetId,
            error: `预设激活诊断不干净：${diagnostic.broken ?? '未知原因'}`,
          }
          return outcome
        }

        // 再确认「这个 agent 身上生效的预设」确实变成了我们要的那个
        const effective = this.agentPresets.composedPreset(agent.ctx)
        if (effective !== workspace.presetId) {
          return {
            status: BIND_STATUS.FAILED,
            presetId: workspace.presetId,
            error: `切换后生效的预设是 ${effective ?? '(未知)'}，不是 ${workspace.presetId}`,
          }
        }

        this.log?.('[session] 会话 %s 已绑定远程预设 %s（%s）', agent.id, workspace.presetId, workspace.profile.id)
        return { status: BIND_STATUS.BOUND, presetId: workspace.presetId, effective }
      } catch (error) {
        const message = String(error?.message ?? error)
        this.log?.('[session] 会话 %s 绑定远程预设失败：%s', agent.id, message)
        return { status: BIND_STATUS.FAILED, presetId: workspace.presetId, error: message, code: error?.code ?? null }
      }
    })()

    this.bindings.set(agent.id, { promise, settled: undefined })
    const outcome = await promise
    this.bindings.set(agent.id, { promise, settled: outcome })
    return outcome
  }

  /** 某个 agent 的绑定结果（诊断用）。 */
  statusOf(agentId) {
    return this.bindings.get(agentId)?.settled
  }

  /** 清掉某个 agent 的状态（agent 释放时）。 */
  forget(agentId) {
    return this.bindings.delete(agentId)
  }
}

/**
 * 判断一个 cwd 是否落在某个锚点目录下。
 *
 * 注意：宿主按 `header.cwd` 索引会话，所以「会话属于哪台机器」完全由 cwd 决定。
 * 这里**不做任何回退** —— 匹配不上就是本地会话。
 *
 * @param {string} cwd
 * @param {string[]} anchors
 * @returns {boolean}
 */
export function cwdIsAnchor(cwd, anchors) {
  if (typeof cwd !== 'string' || cwd === '') return false
  const normalize = (value) => {
    const trimmed = String(value).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
  }
  const target = normalize(cwd)
  return anchors.some((anchor) => normalize(anchor) === target)
}

/** 预设 id 的便捷再导出（绑定逻辑与连接逻辑必须用同一个常量）。 */
export { PRESET_ID }
