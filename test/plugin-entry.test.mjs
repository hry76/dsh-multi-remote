/**
 * `src/index.js` 的入口契约测试。
 *
 * ## 为什么必须有
 *
 * `index.js` 是插件的**宿主半边入口** —— 工具注册、自检路由、栅栏、卸载清理
 * 全在这里。它之前**一条测试都没有**：只在需要真宿主 + 真靶机的端到端里被间接跑过。
 *
 * 这里用一个假 `ctx` 把它挂起来，然后**真的发请求**（`req`/`res` 用最小替身），
 * 所以覆盖的是真实代码路径，不是「函数被调用了」这种弱断言。
 *
 * 重点覆盖三件只有这里能验的事：
 *   1. **栅栏真的挡得住跨站**（fail-closed）—— 这是安全红线
 *   2. **自检路由如实报告**（预设 broken 要说出来，不能报 ok）
 *   3. **卸载清理**：连接断掉 + 预设注销（可重复挂载的前提）
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROOT_CHECK_MARKER } from '../src/session/verify-root.js'
import { apply, name, inject } from '../src/index.js'
import { registeredProfileIds, clearTransports } from '../src/transport/registry.js'
import { TRANSPORT_ERROR, TransportError } from '../src/transport/transport.js'
import { saveProfile } from '../src/session/profile.js'
import { AuditLog } from '../src/audit.js'

// transport 注册表是**模块级单例**，跨测试会串味 —— 每个用例前清干净。
// （负对照：不清 → 上一个用例留下的档案 id 让后面的断言看到幽灵连接）
beforeEach(() => clearTransports())

/** 造一个够用的假 ctx，并记录一切注册。 */
function fakeCtx(options = {}) {
  const routes = new Map()
  const effects = []
  const logs = []

  // `tools` 既要能被插件当服务用（register/get/schemas），
  // 又要能被测试当注册表看（Map 语义）—— 所以做成 Map + 方法
  const tools = new Map()
  tools.register = function register(definition) {
    this.set(definition.name, definition)
    return () => this.delete(definition.name)
  }
  tools.get = Map.prototype.get.bind(tools)
  tools.schemas = () => [...tools.values()].map((definition) => ({ name: definition.name }))

  const ctx = {
    routes,
    tools,
    effects,
    logs,
    /**
     * `ctx.get(name)` —— 宿主里用来**软依赖**一个可选服务。
     * 默认什么都取不到（= 服务缺失），用 `services` 显式给。
     * 我们刻意不把 `directoryPickerController` 写进 `inject`：声明成硬依赖会让
     * 「没有它的 profile」整个插件挂不上去，所以这里必须有「取不到」这条路。
     */
    get(name) {
      return options.services?.[name]
    },
    // SessionBinder 要挂 agent/created 与 agent/pre-step 钩子
    listeners: new Map(),
    on(event, listener) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set())
      this.listeners.get(event).add(listener)
      return () => this.listeners.get(event)?.delete(listener)
    },
    logger: {
      info: (...args) => logs.push(['info', args]),
      warn: (...args) => logs.push(['warn', args]),
      error: (...args) => logs.push(['error', args]),
    },
    agentPresets: options.agentPresets ?? {
      async register() {
        return async () => {}
      },
      async compositionInventory() {
        return []
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    /**
     * 模拟 Cordis 的 `ctx.effect`：
     *   - 调用 `fn()` 做注册
     *   - **返回它给出的 disposer**（`fn()` 的返回值就是清理函数）
     * 所以「跑清理」= 调用 `fn()` 再调用它返回的那个函数。
     */
    effect(fn, label) {
      effects.push({ label, fn })
      const disposer = fn()
      return () => disposer?.()
    },
    dshHomePath: (...segments) => join(options.home ?? tmpdir(), ...segments),
  }
  return ctx
}

/** 最小 req / res 替身，用来真的发一次请求。 */
function fakeHttp({ method = 'GET', host = '127.0.0.1:19388', origin, secFetchSite, url = '/', body } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite
  // POST 的请求体：`readJsonBody` 是按 `on('data') → on('end')` 读的，
  // 这里同步喂进去即可（注册 data 时立刻发，注册 end 时立刻结束）。
  const chunks = body === undefined
    ? []
    : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]
  const req = {
    method,
    headers,
    url,
    on(event, listener) {
      if (event === 'data') for (const chunk of chunks) listener(chunk)
      else if (event === 'end') listener()
      return req
    },
    destroy() {},
  }
  const captured = { status: 0, headers: {}, body: '' }
  const res = {
    writeHead(status, responseHeaders) {
      captured.status = status
      Object.assign(captured.headers, responseHeaders ?? {})
      return res
    },
    end(chunk) {
      captured.body += chunk === undefined ? '' : String(chunk)
      return res
    },
    setHeader(name, value) {
      captured.headers[name] = value
    },
  }
  return { req, res, captured }
}

/** 一个会记账的假 agentPresets：注册进 inventory，注销时移除。 */
function fakeAgentPresets(options = {}) {
  const inventory = new Map()
  const unregistered = []
  return {
    inventory,
    unregistered,
    async register(definition) {
      // 宿主的 register() 会 await 激活；激活失败不抛，只记 record.broken。
      // 这里模拟「激活成功」，并且让 compositionInventory 能回读到 ——
      // 因为 `PresetRegistry.verify()` 靠回读判断有没有静默降级。
      inventory.set(definition.id, {
        id: definition.id,
        // ⚠️ 不能写 `broken: undefined` —— `PresetRegistry.verify()` 判可用性用的是
        // `row.broken === undefined`（不是 `=== null`），写成 undefined 会让预设被判成不可用。
        // 宿主真实的 inventory 里「没坏」就是不出现 broken 这个键。
        rows: Array.isArray(definition.plugins?.[0]?.config) ? definition.plugins[0].config : [],
      })
      return async () => {
        unregistered.push(definition.id)
        inventory.delete(definition.id)
      }
    },
    async compositionInventory() {
      if (options.inventoryThrows === true) throw new Error('宿主内部错误')
      if (options.inventory !== undefined) return options.inventory
      return [...inventory.values()]
    },
  }
}

/** 默认的假探测：单元测试**不该**去连真 Docker / 真 WSL。 */
const fakeProbe = async () => ({
  ssh: { status: 'client-ready', detail: '客户端可用' },
  wsl: { status: 'available', detail: '找到 1 个发行版', distros: ['Ubuntu-24.04'] },
  docker: { status: 'available', detail: '守护进程 29.8.1' },
})

async function mountPlugin(options = {}) {
  const ctx = fakeCtx({
    ...options,
    agentPresets: options.agentPresets ?? fakeAgentPresets(),
  })
  apply(ctx, {
    probeBackends: options.config?.probeBackends ?? fakeProbe,
    ...options.config,
  })
  return ctx
}

// ── 入口契约 ────────────────────────────────────────────────────────────────

test('入口：导出 name / inject / apply，且 inject 声明了必需服务', () => {
  assert.equal(name, '@jk-uzi/dsh-multi-remote')
  assert.equal(typeof apply, 'function')
  for (const service of ['agentPresets', 'tools', 'webServer']) {
    assert.ok(inject.includes(service), `inject 必须声明 ${service}`)
  }
  // 负对照：少声明一个服务 → 宿主不会等它就绪，apply 里访问 ctx.agentPresets 会炸
})

test('入口：注册五个 remote_* 工具，且形状正确', async () => {
  const ctx = await mountPlugin()
  assert.deepEqual(
    [...ctx.tools.keys()].sort(),
    ['remote_connect', 'remote_disconnect', 'remote_list', 'remote_profiles', 'remote_refresh'],
  )
  for (const [toolName, definition] of ctx.tools) {
    assert.equal(definition.name, toolName)
    assert.equal(typeof definition.execute, 'function', `${toolName} 必须有 execute`)
    assert.ok(definition.output?.schema !== undefined, `${toolName} 的 output 必须是 { schema, render }`)
    assert.equal(typeof definition.output.render, 'function', `${toolName} 的 output.render 必须是函数`)
  }
  // 负对照：output 给裸 schema → 宿主报 unsupported JSON schema，预设激活失败
})

test('入口：注册全部路由，路径不与宿主 /api 冲突', async () => {
  const ctx = await mountPlugin()
  assert.deepEqual([...ctx.routes.keys()].sort(), [
    '/multi-remote/audit',
    '/multi-remote/client-report',
    '/multi-remote/connect',
    '/multi-remote/connect-options',
    '/multi-remote/machine-connect',
    '/multi-remote/machine-disconnect',
    '/multi-remote/machine-list',
    '/multi-remote/machine-open',
    '/multi-remote/open-cancel',
    '/multi-remote/open-progress',
    '/multi-remote/open-workspace',
    '/multi-remote/pick-directory',
    '/multi-remote/ping',
    '/multi-remote/selfcheck',
    '/multi-remote/settings',
    '/multi-remote/workspaces',
  ])
  for (const path of ctx.routes.keys()) {
    assert.ok(!path.startsWith('/api'), `${path} 不该占用宿主的 /api 前缀`)
  }
  // 负对照：路由挂在 /api 下 → 被宿主的栅栏与 cookie 认证接管，我们的栅栏失效
})

test('设置路由：GET 报**生效值**；没有 configEditor 时如实说改不了', async () => {
  const ctx = await mountPlugin({ config: { auditCapacity: 42 } })
  const route = ctx.routes.get('/multi-remote/settings')

  const get = fakeHttp({ method: 'GET' })
  await route.handler(get.req, get.res)
  assert.equal(get.captured.status, 200)
  const body = JSON.parse(get.captured.body)
  assert.equal(body.ok, true)
  assert.equal(body.editable, false, '假 ctx 里没有 configEditor 服务')
  assert.equal(body.config.auditCapacity, 42, '要报**生效值**，不是默认值')
  assert.equal(typeof body.config.mirrorDeepen.enabled, 'boolean')
  assert.ok(body.limits.auditCapacity.min > 0, '要把取值范围告诉界面')

  const post = fakeHttp({ method: 'POST', body: { auditCapacity: 100 } })
  await route.handler(post.req, post.res)
  const saved = JSON.parse(post.captured.body)
  assert.equal(saved.ok, false, '没有服务时**不许假装保存成功**')
  assert.match(saved.error, /configEditor/)
  // 负对照：假装成功 → 用户以为改了，重启后原样，还不知道为什么
})

test('设置路由：把补丁**合并**进配置（不抹掉没提到的字段）', async () => {
  const calls = []
  // ⚠️ Entry 的形状是**实测**出来的（2026-10-09）：包名在 `entry.options.name`，
  // `entry.name` / `entry.patchId` 都是 null，id 是 `include:multi-remote`。
  // 一开始按 `entry.name` 找 → 永远找不到 → 用户点保存得到「找不到本插件那一行」。
  const ours = { id: 'include:multi-remote', options: { name: '@jk-uzi/dsh-multi-remote' } }
  const editor = {
    entries: () => [ours, { id: 'include:other', options: { name: '@x/y' } }],
    async edit(target, change) {
      calls.push({ target, next: change({ auditCapacity: 300, mirrorDeepen: { enabled: true, maxFileBytes: 1 } }, {}) })
    },
  }
  const ctx = await mountPlugin({ services: { configEditor: editor } })
  const route = ctx.routes.get('/multi-remote/settings')

  const get = fakeHttp({ method: 'GET' })
  await route.handler(get.req, get.res)
  assert.equal(JSON.parse(get.captured.body).editable, true)

  const post = fakeHttp({
    method: 'POST',
    body: { auditCapacity: 100, mirrorDeepen: { maxTotalBytesMiB: 8 } },
  })
  await route.handler(post.req, post.res)
  const saved = JSON.parse(post.captured.body)
  assert.equal(saved.ok, true, saved.error)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].target, ours, '要改的是**我们自己那一行**')
  assert.equal(calls[0].next.auditCapacity, 100)
  assert.equal(calls[0].next.mirrorDeepen.enabled, true, '没提到的字段不能被抹掉')
  assert.equal(calls[0].next.mirrorDeepen.maxFileBytes, 1, '没提到的字段不能被抹掉')
  assert.equal(calls[0].next.mirrorDeepen.maxTotalBytes, 8 * 1024 * 1024, 'MiB 要换算成字节')
  // 负对照：整体替换 mirrorDeepen → 用户没碰的项被静默重置
})

test('设置路由：非法值明确报 400，不静默改成默认值', async () => {
  const ctx = await mountPlugin({ services: { configEditor: { entries: () => [], async edit() {} } } })
  const route = ctx.routes.get('/multi-remote/settings')
  for (const bad of [
    { auditCapacity: 'many' },
    { auditCapacity: 1 },
    { mirrorDeepen: { maxFileBytesMiB: 99999 } },
    { mirrorDeepen: { enabled: 'yes' } },
  ]) {
    const post = fakeHttp({ method: 'POST', body: bad })
    await route.handler(post.req, post.res)
    assert.equal(post.captured.status, 400, `应当拒绝：${JSON.stringify(bad)}`)
  }
  // 负对照：静默取默认值 → 用户以为保存成功，实际是另一个数
})

test('界面路由：没有目录选择服务时如实报 501，不假装成功', async () => {  // 默认假 ctx 的 `get` 什么都取不到 —— 正是「这个 profile 没有选择服务」的情形
  const ctx = await mountPlugin()
  const route = ctx.routes.get('/multi-remote/pick-directory')
  const { req, res, captured } = fakeHttp({ method: 'POST' })
  await route.handler(req, res)
  assert.equal(captured.status, 501)
  assert.match(captured.body, /没有目录选择服务/)
  // 负对照：假装成功返回 `{ok:true, path:null}` → 用户以为「我取消了」，
  //          而其实是这个环境根本没有选择服务，永远点不出窗口
})

test('界面路由：目录选择服务抛错时返回 ok:false 而不是 500', async () => {
  const ctx = await mountPlugin({
    services: { directoryPickerController: { pick: async () => { throw new Error('窗口打不开') } } },
  })
  const route = ctx.routes.get('/multi-remote/pick-directory')
  const { req, res, captured } = fakeHttp({ method: 'POST' })
  await route.handler(req, res)
  assert.equal(captured.status, 200, '业务失败不是 HTTP 失败')
  assert.match(captured.body, /窗口打不开/)
  // 负对照：抛到 500 → 界面只看到「服务器错误」，丢失真正的原因
})

test('界面路由：connect-options 不含任何凭据', async () => {
  const ctx = await mountPlugin()
  const route = ctx.routes.get('/multi-remote/connect-options')
  const { req, res, captured } = fakeHttp({ method: 'GET' })
  await route.handler(req, res)
  assert.equal(captured.status, 200)
  const body = JSON.parse(captured.body)
  assert.equal(body.ok, true)
  assert.deepEqual(body.kinds, ['wsl', 'ssh', 'docker'])
  // 认证相关字段里**只有私钥路径**允许出现 —— 它是**路径**不是凭据（凭据是
  // 私钥**内容**与口令），而界面正是靠它把「用过的连接」填满。
  //
  // ⚠️ 这里不能用 `includes('privateKey')`：那是 `privateKeyPath` 的子串。
  // 改成按键名匹配（任意深度），既避开子串问题，又保留「字段级」的强断言。
  const flat = JSON.stringify(body)
  for (const field of ['password', 'passphrase', 'privateKey']) {
    assert.ok(!new RegExp(`"${field}"\\s*:`).test(flat), `connect-options 不该出现 ${field} 字段`)
  }
  assert.ok(/"privateKeyPath"\s*:/.test(flat), '私钥路径应当出现（否则「用过的连接」填不满）')
})

test('界面路由：没有「显示/隐藏入口」的自造开关 —— 插件的开与关由 DSH 自己管', async () => {
  const ctx = await mountPlugin()
  const route = ctx.routes.get('/multi-remote/connect-options')
  const { req, res, captured } = fakeHttp({ method: 'GET' })
  await route.handler(req, res)
  assert.ok(!('workspaceFlow' in JSON.parse(captured.body)), 'connect-options 不该再暴露入口开关')
  // 负对照：留着一个和宿主插件开关重复、而且改了要刷新页面才生效的开关
  //          → 用户看到两个「开关」，还不知道哪个算数
})

// ── 栅栏（安全红线）─────────────────────────────────────────────────────────
test('栅栏：跨站请求一律 403，且不回显任何配置', async () => {
  const ctx = await mountPlugin()
  const route = ctx.routes.get('/multi-remote/ping')

  // 1) Host 不是回环
  {
    const { req, res, captured } = fakeHttp({ host: 'evil.example.com' })
    route.handler(req, res)
    assert.equal(captured.status, 403, '非回环 Host 必须拒绝')
    assert.equal(captured.body, 'forbidden')
  }
  // 2) Sec-Fetch-Site: cross-site
  {
    const { req, res, captured } = fakeHttp({ secFetchSite: 'cross-site' })
    route.handler(req, res)
    assert.equal(captured.status, 403, 'cross-site 必须拒绝')
  }
  // 3) Origin 与 Host 不同源
  {
    const { req, res, captured } = fakeHttp({ origin: 'http://evil.example.com' })
    route.handler(req, res)
    assert.equal(captured.status, 403, '跨源 Origin 必须拒绝')
  }
  // 负对照：不校验 Origin → 浏览器里的任意网页都能调这个本地接口
  // （参考项目有真实事故：不校验 Origin 导致任何网页都能建隧道、改机器清单）
})

test('栅栏：回环 + 同源请求放行', async () => {
  const ctx = await mountPlugin()
  const route = ctx.routes.get('/multi-remote/ping')
  const { req, res, captured } = fakeHttp({ origin: 'http://127.0.0.1:19388' })
  route.handler(req, res)
  assert.equal(captured.status, 200)
  assert.equal(JSON.parse(captured.body).ok, true)
  // 负对照：把同源也拒掉 → 界面自己的请求都失败
})

// ── 自检路由：如实报告 ──────────────────────────────────────────────────────

test('自检：工具都在时 ok=true，并列出预设与 transport', async () => {
  const ctx = await mountPlugin({
    agentPresets: fakeAgentPresets({
      inventory: [
        { id: 'multi-remote-abc', broken: undefined, rows: [{}, {}] },
        { id: 'someone-elses-preset', broken: undefined, rows: [] },
      ],
    }),
  })
  const { req, res, captured } = fakeHttp()
  await ctx.routes.get('/multi-remote/selfcheck').handler(req, res)

  const body = JSON.parse(captured.body)
  assert.equal(captured.status, 200)
  assert.equal(body.ok, true, '五个工具都注册了就该是 ok')
  assert.equal(body.plugin, name)
  assert.ok(body.tools.length === 5)
  assert.ok(body.tools.every((entry) => entry.registered && entry.visibleToModel))

  // 只列我们自己的预设，不列别人的
  assert.deepEqual(body.presets.map((entry) => entry.id), ['multi-remote-abc'])
  assert.equal(body.presets[0].broken, null, '没坏就该是 null')
  assert.equal(body.presets[0].rows, 2)
  // 负对照：把别人的预设也列进来 → 用户以为那些也是本插件建的
})

test('自检：预设 broken 时必须如实报出来（这是唯一能发现静默降级的地方）', async () => {
  const ctx = await mountPlugin({
    agentPresets: fakeAgentPresets({
      inventory: [{ id: 'multi-remote-broken', broken: 'world-fs: profileId 必填', rows: [] }],
    }),
  })
  const { req, res, captured } = fakeHttp()
  await ctx.routes.get('/multi-remote/selfcheck').handler(req, res)

  const body = JSON.parse(captured.body)
  assert.equal(body.presets[0].broken, 'world-fs: profileId 必填', 'broken 必须原样透出')
  // 负对照：把 broken 吞掉 → 用户看到「一切正常」，而会话其实拒绝连接
})

test('自检：compositionInventory 抛错时不崩，把错误报出来', async () => {
  const ctx = await mountPlugin({
    agentPresets: fakeAgentPresets({ inventoryThrows: true }),
  })
  const { req, res, captured } = fakeHttp()
  await ctx.routes.get('/multi-remote/selfcheck').handler(req, res)

  const body = JSON.parse(captured.body)
  assert.equal(captured.status, 200, '自检自己不该崩')
  assert.ok(body.presets[0].error.includes('宿主内部错误'))
  // 负对照：不 try/catch → 自检 500，用户在最需要诊断的时候拿不到任何信息
})

test('自检：非 GET 返回 405', async () => {
  const ctx = await mountPlugin()
  const { req, res, captured } = fakeHttp({ method: 'POST' })
  await ctx.routes.get('/multi-remote/selfcheck').handler(req, res)
  assert.equal(captured.status, 405)
  // 负对照：POST 也当 GET 处理 → 语义混乱，且将来加写操作时容易出事
})

test('自检：报告三种后端的可用性（先回答「能不能用」）', async () => {
  // 注入假探测：单元测试不该去连真 Docker / 真 WSL（慢，且结果随机器而异）
  const ctx = await mountPlugin({
    config: {
      probeBackends: async () => ({
        ssh: { status: 'client-ready', detail: '客户端可用' },
        wsl: { status: 'available', detail: '找到 1 个发行版', distros: ['Ubuntu-24.04'] },
        docker: { status: 'unavailable', detail: '连不上 Docker 守护进程' },
      }),
    },
  })
  const { req, res, captured } = fakeHttp()
  await ctx.routes.get('/multi-remote/selfcheck').handler(req, res)

  const body = JSON.parse(captured.body)
  assert.ok(body.backends !== null, '默认应当探测后端可用性')
  assert.equal(body.backends.ssh.status, 'client-ready')
  assert.equal(body.backends.wsl.status, 'available')
  assert.deepEqual(body.backends.wsl.distros, ['Ubuntu-24.04'])
  // 探不到的那条也要如实透出原因
  assert.equal(body.backends.docker.status, 'unavailable')
  assert.match(body.backends.docker.detail, /连不上/)
  // 负对照：只报工具是否注册 → 用户不知道这台机器上哪种后端能用，
  // 只能一个个去试，失败了也不知道是环境问题还是配置问题
})

test('自检：探测本身抛错时不崩，把错误报出来', async () => {
  const ctx = await mountPlugin({
    config: {
      probeBackends: async () => {
        throw new Error('探测炸了')
      },
    },
  })
  const { req, res, captured } = fakeHttp()
  await ctx.routes.get('/multi-remote/selfcheck').handler(req, res)

  const body = JSON.parse(captured.body)
  assert.equal(captured.status, 200, '自检自己不该崩')
  assert.match(body.backends.error, /探测炸了/)
  // 负对照：不 try/catch → 自检 500，用户在最需要诊断时拿不到任何信息
})

test('自检：?backends=0 可以跳过探测（脚本里只想要工具状态时用）', async () => {
  const ctx = await mountPlugin()
  const { req, res, captured } = fakeHttp({ url: '/multi-remote/selfcheck?backends=0' })
  await ctx.routes.get('/multi-remote/selfcheck').handler(req, res)

  const body = JSON.parse(captured.body)
  assert.equal(body.backends, null, '显式跳过时应当是 null')
  // 负对照：探测要几秒（Docker 握手 + WSL 列举），脚本轮询时白等
})

test('workspaces 路由：没有连接时返回空列表而不是报错', async () => {
  const ctx = await mountPlugin()
  const { req, res, captured } = fakeHttp()
  await ctx.routes.get('/multi-remote/workspaces').handler(req, res)
  assert.equal(captured.status, 200)
  assert.deepEqual(JSON.parse(captured.body).workspaces, [])
  // 负对照：没有连接就 500 → 界面刚打开就报错
})

// ── 审计日志 ────────────────────────────────────────────────────────────────

test('审计：栅栏拒绝要记进审计（那是安全事件，不能只回 403 就完了）', async () => {
  const audit = new AuditLog({ capacity: 50 })
  const ctx = await mountPlugin({ config: { auditLog: audit } })

  const { req, res } = fakeHttp({ host: 'evil.example.com' })
  ctx.routes.get('/multi-remote/ping').handler(req, res)

  const page = audit.read({ event: 'fence-rejected' })
  assert.equal(page.total, 1, '拒绝必须留下记录')
  assert.equal(page.entries[0].detail.host, 'evil.example.com')
  assert.equal(page.entries[0].detail.status, 403)
  // 负对照：只回 403 不记录 → 有人扫描本地端口时完全无迹可循
})

test('审计：连接成功与失败都记账，且**不含凭据**', async () => {
  const audit = new AuditLog({ capacity: 50 })
  const presets = fakeAgentPresets()

  // 成功那条
  const okCtx = await mountPlugin({
    agentPresets: presets,
    config: { auditLog: audit, createTransport: () => fakeTransport() },
  })
  await okCtx.tools.get('remote_connect').execute(
    {
      id: 'audit-ok',
      kind: 'docker',
      container: 'c',
      remoteRoot: '/remote/proj',
      anchorParent: join(tmpdir(), 'mr-anchors'),
    },
    { agent: undefined, signal: new AbortController().signal },
  )
  const ok = audit.read({ event: 'connect-ok' })
  assert.equal(ok.total, 1)
  assert.equal(ok.entries[0].detail.kind, 'docker')
  assert.equal(ok.entries[0].detail.remoteRoot, '/remote/proj')

  // 失败那条（用一个连不上的 transport）
  const badCtx = await mountPlugin({
    agentPresets: fakeAgentPresets(),
    config: {
      auditLog: audit,
      createTransport: () => ({
        kind: 'ssh',
        async connect() {
          // 故意把口令夹进错误信息里 —— 审计必须把它抹掉
          throw new TransportError(TRANSPORT_ERROR.AUTH_FAILED, '认证失败：password=hunter2', {
            operation: 'connect',
          })
        },
        async disconnect() {},
      }),
    },
  })
  await badCtx.tools.get('remote_connect').execute(
    {
      id: 'audit-bad',
      kind: 'ssh',
      host: 'h',
      username: 'u',
      // 至少要给一种认证方式，否则档案校验就先把这次调用挡掉了
      // （那样测的就不是「连接失败」，而是「档案非法」）
      privateKey: 'KEYDATA',
      remoteRoot: '/r',
      anchorParent: join(tmpdir(), 'a'),
    },
    { agent: undefined, signal: new AbortController().signal },
  )
  const failed = audit.read({ event: 'connect-failed' })
  assert.equal(failed.total, 1)
  assert.equal(failed.entries[0].detail.code, TRANSPORT_ERROR.AUTH_FAILED)
  assert.ok(!JSON.stringify(failed.entries).includes('hunter2'), '错误信息里的口令必须被抹掉')
  assert.ok(!JSON.stringify(failed.entries).includes('KEYDATA'), '私钥内容绝不能进审计')
  // 负对照：把原始 profile 塞进审计 → 口令与私钥进了内存日志
})

test('审计：/multi-remote/audit 路由能读、能按事件过滤、能清空', async () => {
  const audit = new AuditLog({ capacity: 50 })
  const ctx = await mountPlugin({ config: { auditLog: audit } })
  audit.record('connect-ok', { a: 1 })
  audit.record('connect-failed', { a: 2 })

  const route = ctx.routes.get('/multi-remote/audit')

  // 读全部
  {
    const { req, res, captured } = fakeHttp()
    route.handler(req, res)
    const body = JSON.parse(captured.body)
    assert.equal(body.ok, true)
    assert.equal(body.total, 2)
    assert.equal(body.capacity, 50)
  }
  // 按事件过滤
  {
    const { req, res, captured } = fakeHttp({ url: '/multi-remote/audit?event=connect-failed' })
    route.handler(req, res)
    assert.equal(JSON.parse(captured.body).total, 1)
  }
  // limit
  {
    const { req, res, captured } = fakeHttp({ url: '/multi-remote/audit?limit=1' })
    route.handler(req, res)
    assert.equal(JSON.parse(captured.body).entries.length, 1)
  }
  // 清空
  {
    const { req, res, captured } = fakeHttp({ url: '/multi-remote/audit?clear=1' })
    route.handler(req, res)
    const body = JSON.parse(captured.body)
    assert.equal(body.cleared, 2)
    assert.equal(audit.read().total, 1, '清空动作本身会被记一条，便于回溯「谁清了」')
  }
  // 非 GET
  {
    const { req, res, captured } = fakeHttp({ method: 'POST' })
    route.handler(req, res)
    assert.equal(captured.status, 405)
  }
  // 负对照：审计只能写不能读 → 出了问题用户拿不到证据
})

test('审计：自检里给条数摘要，不刷屏', async () => {
  const audit = new AuditLog({ capacity: 50 })
  const ctx = await mountPlugin({ config: { auditLog: audit } })
  audit.record('a')
  audit.record('b')

  const { req, res, captured } = fakeHttp()
  await ctx.routes.get('/multi-remote/selfcheck').handler(req, res)
  const body = JSON.parse(captured.body)
  assert.equal(body.audit.total, 2)
  assert.equal(body.audit.dropped, 0)
  assert.equal(body.audit.entries, undefined, '自检里不该塞明细')
  // 负对照：自检里塞 500 条明细 → 响应巨大，界面卡
})

// ── 卸载清理 ────────────────────────────────────────────────────────────────

/** 一个够用的假 transport：连上就能用，断开时可选择抛错。 */
function fakeTransport(options = {}) {
  return {
    kind: 'docker',
    connected: false,
    disconnected: 0,
    async connect() {
      this.connected = true
    },
    async disconnect() {
      this.disconnected += 1
      this.connected = false
      if (options.failDisconnect === true) {
        throw new TransportError(TRANSPORT_ERROR.CHANNEL_DEAD, '通道已死', { operation: 'disconnect' })
      }
    },
    async testConnection() {
      return { ok: true }
    },
    /** 连接前会探测远程根是否存在（见 src/session/verify-root.js）—— 假机器回答「存在」。 */
    async exec(command) {
      if (String(command).includes(ROOT_CHECK_MARKER)) return { code: 0, stdout: 'OK\nPARENT_OK\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
    async realpath(path) {
      return path
    },
    async stat() {
      return { type: 'file', size: 0, mtimeMs: 1_700_000_000_000 }
    },
    async readdir() {
      return []
    },
    async readFile() {
      return ''
    },
    async writeFileAtomic() {},
  }
}

/**
 * 跑一个 effect 的清理。
 *
 * ⚠️ 注意语义：`fn()` 是**注册**，它**返回**的才是清理函数。
 * 所以「跑清理」= `fn()` 然后调用它的返回值。
 * （一开始直接 `await fn()` 拿到的是一个函数，清理根本没执行 —— 测试却「通过」了。）
 */
async function runEffectCleanup(ctx, labelFragment) {
  const entry = ctx.effects.find((item) => item.label.includes(labelFragment))
  assert.ok(entry !== undefined, `应当注册了包含「${labelFragment}」的 effect`)
  const disposer = entry.fn()
  assert.equal(typeof disposer, 'function', `effect「${entry.label}」的 fn() 应当返回清理函数`)
  return disposer()
}

test('卸载：清理函数会断开全部连接并注销预设（可重复挂载的前提）', async () => {
  const presets = fakeAgentPresets()
  const transport = fakeTransport()
  const ctx = await mountPlugin({
    config: { createTransport: () => transport },
    agentPresets: presets,
  })

  // 真的建一个连接（走 connect 路径）
  const connectTool = ctx.tools.get('remote_connect')
  const connected = await connectTool.execute(
    {
      id: 'cleanup-test',
      kind: 'docker',
      container: 'some-container',
      remoteRoot: '/remote/proj',
      anchorParent: join(tmpdir(), 'mr-anchors'),
    },
    { agent: undefined, signal: new AbortController().signal },
  )
  assert.equal(connected.ok, true, `连接应当成功：${connected.message}`)
  assert.deepEqual(registeredProfileIds(), ['cleanup-test'])

  await runEffectCleanup(ctx, '清理连接、机器与预设')

  assert.equal(transport.disconnected, 1, '清理必须真的断开连接')
  assert.deepEqual(registeredProfileIds(), [], '清理后 transport 必须从注册表移除')
  assert.equal(presets.unregistered.length, 1, '清理必须注销预设')
  // 负对照：不注销 → 重连时撞 Duplicate transport / Duplicate agent preset，用户只能重启宿主
})

test('卸载：一个连接断开失败也不影响其他清理（幂等可重挂的前提）', async () => {
  const presets = fakeAgentPresets()
  const transport = fakeTransport({ failDisconnect: true })
  const ctx = await mountPlugin({
    config: { createTransport: () => transport },
    agentPresets: presets,
  })

  await ctx.tools.get('remote_connect').execute(
    {
      id: 'angry',
      kind: 'docker',
      container: 'c',
      remoteRoot: '/remote/proj',
      anchorParent: join(tmpdir(), 'mr-anchors'),
    },
    { agent: undefined, signal: new AbortController().signal },
  )

  await runEffectCleanup(ctx, '清理连接、机器与预设')

  assert.deepEqual(registeredProfileIds(), [], '即使断开抛错，transport 也要从注册表移除')
  assert.equal(presets.unregistered.length, 1, '即使断开抛错，预设也要注销')
  // 负对照：一个失败就中断清理 → 剩下的连接与预设全留在内存里，插件再也装不回来
})

test('remote_profiles：机器级档案（没有项目根）不许打印出 undefined', async () => {
  // ⚠️ 界面里「用过的连接」存的是**机器级档案**（`machine: true`，**没有 remoteRoot**）
  // —— 项目根是第二步（选文件夹）才有的。
  // 直接拼 `${entry.remoteRoot}` 会打印「→ undefined」，看起来像「路径就叫 undefined」，
  // 是**谎报**（agent 读到会以为那是个真路径）。
  const dir = await mkdtemp(join(tmpdir(), 'mr-profiles-'))
  try {
    // 形状对齐 `MachineRegistry` 真实产出的（已规范化 —— `saveProfile` 不再补默认值）
    await saveProfile(dir, {
      id: 'ssh-user-10-0-0-5-22',
      label: 'user@10.0.0.5:22',
      kind: 'ssh',
      host: '10.0.0.5',
      port: 22,
      username: 'user',
      privateKeyPath: '~/.ssh/id_ed25519',
      machine: true,
    })
    const ctx = await mountPlugin({ config: { profileStoreDir: dir } })
    const result = await ctx.tools.get('remote_profiles').execute(
      { action: 'list' },
      { agent: undefined, signal: new AbortController().signal },
    )

    assert.equal(result.ok, true)
    assert.ok(!result.message.includes('undefined'), `不该出现 undefined：\n${result.message}`)
    assert.match(result.message, /还没选项目目录/, '要说清它还没有项目根')
    assert.match(result.message, /user@10\.0\.0\.5:22/, '目标仍要说清楚')
    // 负对照：打印 `→ undefined` → agent 以为项目根叫 undefined
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('machine-open 任务化：返回 taskId，进度轮询到 done，结果含锚点', async () => {
  const ctx = await mountPlugin({ config: { createTransport: () => fakeTransport() } })

  // 1. 先连机器
  const mc = ctx.routes.get('/multi-remote/machine-connect')
  const r1 = fakeHttp({ method: 'POST', body: { kind: 'docker', container: 'c1' } })
  await mc.handler(r1.req, r1.res)
  const machineId = JSON.parse(r1.captured.body).machine.id
  assert.ok(machineId)

  // 2. machine-open → 立即返回 taskId（不阻塞）
  const mo = ctx.routes.get('/multi-remote/machine-open')
  const r2 = fakeHttp({ method: 'POST', body: { machineId, remoteRoot: '/remote/proj' } })
  const t0 = Date.now()
  await mo.handler(r2.req, r2.res)
  assert.ok(Date.now() - t0 < 1000, '启动任务不该阻塞到连接完成')
  const { ok, taskId } = JSON.parse(r2.captured.body)
  assert.equal(ok, true)
  assert.ok(typeof taskId === 'string' && taskId !== '')

  // 3. 轮询进度到 done
  const op = ctx.routes.get('/multi-remote/open-progress')
  let status = 'running'
  for (let i = 0; i < 100 && status === 'running'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const r3 = fakeHttp({ method: 'GET', url: '/multi-remote/open-progress?task=' + taskId })
    await op.handler(r3.req, r3.res)
    status = JSON.parse(r3.captured.body).status
  }
  assert.equal(status, 'done', '任务应当跑到 done')

  // 4. done 后能拿到最终结果（含锚点 + 标题）
  const r4 = fakeHttp({ method: 'GET', url: '/multi-remote/open-progress?task=' + taskId })
  await op.handler(r4.req, r4.res)
  const final = JSON.parse(r4.captured.body)
  assert.equal(final.status, 'done')
  assert.ok(final.result.anchorPath, '结果要带锚点目录')
  assert.ok(final.result.title, '结果要带工作区标题')
  // 负对照：一次性同步返回 → 大项目打开期间界面卡成黑盒
})

test('open-progress：任务不存在时如实报错，不假装在跑', async () => {
  const ctx = await mountPlugin({ config: { createTransport: () => fakeTransport() } })
  const op = ctx.routes.get('/multi-remote/open-progress')
  const r = fakeHttp({ method: 'GET', url: '/multi-remote/open-progress?task=not-exist' })
  await op.handler(r.req, r.res)
  const body = JSON.parse(r.captured.body)
  assert.equal(body.ok, false)
  assert.match(body.error, /不存在|过期/)
  // 负对照：返回 status='running' → 前端无限轮询一个死任务
})

test('open-cancel：对已结束的任务如实报「不存在或已结束」', async () => {
  const ctx = await mountPlugin({ config: { createTransport: () => fakeTransport() } })
  const oc = ctx.routes.get('/multi-remote/open-cancel')
  const r = fakeHttp({ method: 'POST', body: { taskId: 'not-exist' } })
  await oc.handler(r.req, r.res)
  assert.equal(JSON.parse(r.captured.body).ok, false)
  // 负对照：cancel 一个不存在的任务返回 ok:true → 前端以为取消成功，其实什么都没发生
})
