/**
 * `src/session/binder.js` 的契约测试。
 *
 * 这一层承载本项目**最重要的行为**：会话属于远程工作区时，
 * 预设没挂上就必须**拒绝这一步**，绝不能让命令与文件操作静默落在本机。
 *
 * 参考项目正是栽在这里：它只 await「在途切换」，切换失败后第一步照跑 ——
 * 于是用户看到「已连上远程」，agent 却在本机干活。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SessionBinder, BIND_STATUS, cwdIsAnchor } from '../src/session/binder.js'
import { PresetRegistry, presetIdFor } from '../src/session/preset.js'

/** 假的 agent。 */
function fakeAgent(id, cwd) {
  return { id, session: { header: { id, cwd } }, ctx: { agentId: id } }
}

/** 假的插件上下文：收集钩子，方便测试手动触发。 */
function fakeCtx() {
  const hooks = { 'agent/created': [], 'agent/pre-step': [] }
  return {
    hooks,
    on(event, handler) {
      hooks[event].push(handler)
      return () => {
        hooks[event] = hooks[event].filter((entry) => entry !== handler)
      }
    },
    /** 触发某个事件的所有监听器。 */
    async emit(event, payload) {
      const results = []
      for (const handler of hooks[event]) results.push(await handler(payload, async () => ({ kind: 'next' })))
      return results
    },
  }
}

/** 假的 agentPresets。`composedPreset` 会随 select 真实变化（模拟宿主行为）。 */
function fakeAgentPresets(options = {}) {
  const registered = new Set(options.registered ?? [])
  const broken = new Set(options.brokenIds ?? [])
  /** 每个 agent 当前生效的预设。 */
  const effective = new Map()
  return {
    selectCalls: [],
    async register(definition) {
      if (registered.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
      registered.add(definition.id)
      return async () => registered.delete(definition.id)
    },
    async compositionInventory() {
      return [...registered].map((id) => ({
        id,
        isDefault: false,
        ...broken.has(id) ? { broken: 'row never started' } : {},
        rows: broken.has(id) ? [] : [{ id: `${id}-world`, state: 'active' }],
      }))
    },
    async resolve(id) {
      if (!registered.has(id)) throw new Error(`agent-preset/not-found: ${id}`)
      return { id, ...broken.has(id) ? { broken: 'row never started' } : {} }
    },
    async select(agent, presetId) {
      this.selectCalls.push([agent.id, presetId])
      if (!registered.has(presetId)) throw new Error(`agent-preset/not-found: ${presetId}`)
      if (options.selectThrows !== undefined) throw options.selectThrows
      // 宿主切换成功后，该 agent 生效的预设就变了
      effective.set(agent.id, presetId)
    },
    composedPreset(ctx) {
      // 允许测试强制指定一个「切换后依然不是我们要的」结果
      if (options.composedPreset !== undefined) return options.composedPreset
      return effective.get(ctx?.agentId)
    },
  }
}

/** 假的连接管理器：只实现 findByAnchor。 */
function fakeConnections(anchorPath, presetId) {
  return {
    anchorPath,
    workspace: { presetId, profile: { id: 'conn-1' }, anchorPath },
    findByAnchor(cwd) {
      return cwd === anchorPath ? this.workspace : undefined
    },
  }
}

test('cwdIsAnchor：锚点匹配（大小写不敏感），其他目录不算', () => {
  assert.equal(cwdIsAnchor('/a/b', ['/a/b']), true)
  assert.equal(cwdIsAnchor('/a/b/', ['/a/b']), true, '尾斜杠应当被容忍')
  assert.equal(cwdIsAnchor('/a/b', ['/a/b', '/c']), true)
  assert.equal(cwdIsAnchor('/a/other', ['/a/b']), false)
  assert.equal(cwdIsAnchor('', ['/a/b']), false)
  assert.equal(cwdIsAnchor(undefined, ['/a/b']), false)
  // 负对照：不做尾斜杠归一化，宿主给的 `/a/b/` 会被判成本地会话 → 静默在本机跑
})

test('本地会话完全不受影响：不绑定、不 select、放行', async () => {
  const agentPresets = fakeAgentPresets()
  const registry = new PresetRegistry({ agentPresets })
  const connections = fakeConnections('/remote/anchor', 'multi-remote-x')
  const binder = new SessionBinder({ connections, presetRegistry: registry, agentPresets })
  const ctx = fakeCtx()
  binder.install(ctx)

  const agent = fakeAgent('s-local', '/home/me/local-project')
  await ctx.emit('agent/created', { agent })

  assert.equal(agentPresets.selectCalls.length, 0, '本地会话绝不能被 select')
  assert.equal(binder.statusOf('s-local').status, BIND_STATUS.NOT_REMOTE)

  const [result] = await ctx.emit('agent/pre-step', { agent })
  assert.equal(result.kind, 'next', '本地会话必须照常放行')
  // 负对照：把「不是远程会话」也当成要绑定，本地会话会被套上远程预设 ——
  // 用户的本地项目突然开始往远程写
})

test('远程会话：绑定成功，且 select 用的正是派生出来的预设 id', async () => {
  const anchor = '/anchors/mr-conn-1-abc'
  const presetId = presetIdFor('conn-1', '/home/user/proj')
  const agentPresets = fakeAgentPresets({ registered: [presetId] })
  const registry = new PresetRegistry({ agentPresets })
  const connections = fakeConnections(anchor, presetId)
  const binder = new SessionBinder({ connections, presetRegistry: registry, agentPresets })
  const ctx = fakeCtx()
  binder.install(ctx)

  const agent = fakeAgent('s-remote', anchor)
  await ctx.emit('agent/created', { agent })

  assert.deepEqual(agentPresets.selectCalls, [['s-remote', presetId]])
  assert.equal(binder.statusOf('s-remote').status, BIND_STATUS.BOUND)

  const [result] = await ctx.emit('agent/pre-step', { agent })
  assert.equal(result.kind, 'next', '绑定成功时应当放行')
  // 负对照：select 用别的 id（例如写死的常量），多档案场景会全部套同一个预设
})

test('远程会话：预设不可用时拒绝这一步（绝不静默降级到本机）', async () => {
  const anchor = '/anchors/mr-conn-1-abc'
  const presetId = presetIdFor('conn-1', '/home/user/proj')
  const agentPresets = fakeAgentPresets({ registered: [presetId], brokenIds: [presetId] })
  const registry = new PresetRegistry({ agentPresets })
  const connections = fakeConnections(anchor, presetId)
  const binder = new SessionBinder({ connections, presetRegistry: registry, agentPresets })
  const ctx = fakeCtx()
  binder.install(ctx)

  const agent = fakeAgent('s-remote', anchor)
  await ctx.emit('agent/created', { agent })

  const outcome = binder.statusOf('s-remote')
  assert.equal(outcome.status, BIND_STATUS.FAILED, '激活诊断不干净必须判为失败')
  assert.match(outcome.error, /诊断不干净/)

  const [result] = await ctx.emit('agent/pre-step', { agent })
  assert.equal(result.kind, 'reject', '必须拒绝这一步，而不是放它在本机跑')
  assert.match(result.reason, /静默落在本机/)
  assert.match(result.reason, /重新建立会话/)
  // 负对照：pre-step 只看「在途切换有没有结算」，失败后照样放行 ——
  // 这就是参考项目当前的失败形态：界面显示已连上远程，agent 在本机干活
})

test('远程会话：select 抛 agent-preset/locked 时也算失败并拒绝', async () => {
  const anchor = '/anchors/mr-conn-1-abc'
  const presetId = presetIdFor('conn-1', '/home/user/proj')
  const locked = Object.assign(new Error('This session has already started'), { code: 'agent-preset/locked' })
  const agentPresets = fakeAgentPresets({ registered: [presetId], selectThrows: locked })
  const registry = new PresetRegistry({ agentPresets })
  const connections = fakeConnections(anchor, presetId)
  const binder = new SessionBinder({ connections, presetRegistry: registry, agentPresets })
  const ctx = fakeCtx()
  binder.install(ctx)

  const agent = fakeAgent('s-remote', anchor)
  await ctx.emit('agent/created', { agent })

  const outcome = binder.statusOf('s-remote')
  assert.equal(outcome.status, BIND_STATUS.FAILED)
  assert.equal(outcome.code, 'agent-preset/locked')

  const [result] = await ctx.emit('agent/pre-step', { agent })
  assert.equal(result.kind, 'reject')
  // 负对照：把 locked 当成「已经绑好了」放行，用户会以为换了远程其实没有
})

test('远程会话：切换后生效的预设不是我们要的，也判为失败', async () => {
  const anchor = '/anchors/mr-conn-1-abc'
  const presetId = presetIdFor('conn-1', '/home/user/proj')
  const agentPresets = fakeAgentPresets({ registered: [presetId], composedPreset: 'standard' })
  const registry = new PresetRegistry({ agentPresets })
  const connections = fakeConnections(anchor, presetId)
  const binder = new SessionBinder({ connections, presetRegistry: registry, agentPresets })
  const ctx = fakeCtx()
  binder.install(ctx)

  const agent = fakeAgent('s-remote', anchor)
  await ctx.emit('agent/created', { agent })

  const outcome = binder.statusOf('s-remote')
  assert.equal(outcome.status, BIND_STATUS.FAILED)
  assert.match(outcome.error, /生效的预设是 standard/)
  // 负对照：不回读 composedPreset，切换「成功」返回但实际没生效也会被当成成功 ——
  // 这正是研究里指出的、参考项目从不做的那一步
})

test('远程会话：重复绑定是幂等的（不重复 select）', async () => {
  const anchor = '/anchors/mr-conn-1-abc'
  const presetId = presetIdFor('conn-1', '/home/user/proj')
  const agentPresets = fakeAgentPresets({ registered: [presetId] })
  const registry = new PresetRegistry({ agentPresets })
  const connections = fakeConnections(anchor, presetId)
  const binder = new SessionBinder({ connections, presetRegistry: registry, agentPresets })
  const ctx = fakeCtx()
  binder.install(ctx)

  const agent = fakeAgent('s-remote', anchor)
  await ctx.emit('agent/created', { agent })
  await ctx.emit('agent/created', { agent })

  assert.equal(agentPresets.selectCalls.length, 1, '已经绑好就不该再 select')
  // 负对照：每次都 select，第二次会撞 agent-preset/locked → 会话第一步被自己拒掉
})

test('install 返回的清理函数会摘掉两个钩子', async () => {
  const agentPresets = fakeAgentPresets()
  const registry = new PresetRegistry({ agentPresets })
  const connections = fakeConnections('/remote/anchor', 'p')
  const binder = new SessionBinder({ connections, presetRegistry: registry, agentPresets })
  const ctx = fakeCtx()
  const dispose = binder.install(ctx)

  assert.equal(ctx.hooks['agent/created'].length, 1)
  assert.equal(ctx.hooks['agent/pre-step'].length, 1)
  dispose()
  assert.equal(ctx.hooks['agent/created'].length, 0)
  assert.equal(ctx.hooks['agent/pre-step'].length, 0)
  // 负对照：不返回清理函数，插件卸载后钩子还挂着，会对已经不存在的连接做绑定
})

test('没有 agent 的 pre-step 载荷直接放行（不崩）', async () => {
  const agentPresets = fakeAgentPresets()
  const registry = new PresetRegistry({ agentPresets })
  const connections = fakeConnections('/remote/anchor', 'p')
  const binder = new SessionBinder({ connections, presetRegistry: registry, agentPresets })
  const ctx = fakeCtx()
  binder.install(ctx)

  const [result] = await ctx.emit('agent/pre-step', {})
  assert.equal(result.kind, 'next')
  // 负对照：直接读 payload.agent.id 会 TypeError，把整个 step 打挂
})

test('forget：清掉某个 agent 的绑定状态', async () => {
  const agentPresets = fakeAgentPresets()
  const registry = new PresetRegistry({ agentPresets })
  const connections = fakeConnections('/remote/anchor', 'p')
  const binder = new SessionBinder({ connections, presetRegistry: registry, agentPresets })
  const ctx = fakeCtx()
  binder.install(ctx)

  const agent = fakeAgent('s-local', '/local')
  await ctx.emit('agent/created', { agent })
  assert.ok(binder.statusOf('s-local'))
  assert.equal(binder.forget('s-local'), true)
  assert.equal(binder.statusOf('s-local'), undefined)
  // 负对照：不清状态，长跑进程里 bindings 会无限增长
})
