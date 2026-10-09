/**
 * Transport 注册表 —— 把「连接档案」映射到活的 transport 实例。
 *
 * ## 为什么需要一个跨隔离域的注册表
 *
 * 预设的行在**隔离域**里挂载，而我们在这里拿不到那个域的上下文。
 * 反过来，隔离域里的 provider 也需要拿到「这个连接档案对应的 transport」。
 * 两者唯一的共同点就是宿主进程本身，所以注册表放在模块级 —— 这是有意的设计，
 * 不是偷懒：它是**只读查询**，域内 provider 只能按 profileId 取，不能改。
 *
 * 注意这不是「服务泄漏」：注册表本身不是 cordis 服务，不参与依赖注入，
 * 也就不会被 `mountPreset()` 的 `leakedServices` 审计拦下。
 */

/** @type {Map<string, import('./transport.js').Transport>} */
const transports = new Map()

/**
 * 注册一个 transport。同一 profileId 重复注册会抛错 ——
 * 静默覆盖会让「命令发往了错误的机器」，这是参考项目踩过的真实事故。
 *
 * @param {string} profileId
 * @param {import('./transport.js').Transport} transport
 */
export function registerTransport(profileId, transport) {
  const key = String(profileId ?? '').trim()
  if (key === '') throw new Error('registerTransport 需要非空的 profileId')
  if (transport === undefined || transport === null) throw new Error('registerTransport 需要 transport 实例')
  if (transports.has(key)) {
    throw new Error(`连接档案 ${key} 已经注册过 transport（静默覆盖会让命令发往错误的机器）`)
  }
  transports.set(key, transport)
}

/**
 * 取一个 transport。
 *
 * **取不到必须抛错，绝不返回 undefined 让调用方回退到本机** ——
 * 「解析不到会话属于哪台机器就明确报错，绝不回退」是本项目的硬约束。
 *
 * @param {string} profileId
 * @returns {import('./transport.js').Transport}
 */
export function requireTransport(profileId) {
  const key = String(profileId ?? '').trim()
  const transport = transports.get(key)
  if (transport === undefined) {
    throw new Error(
      `找不到连接档案 ${JSON.stringify(key)} 的 transport —— 拒绝在本机降级执行`,
    )
  }
  return transport
}

/** 注销一个 transport（断开连接时调用）。 */
export function unregisterTransport(profileId) {
  return transports.delete(String(profileId ?? '').trim())
}

/** 当前已注册的档案 id（诊断用）。 */
export function registeredProfileIds() {
  return [...transports.keys()]
}

/** 清空注册表（测试与插件卸载用）。 */
export function clearTransports() {
  const count = transports.size
  transports.clear()
  return count
}
