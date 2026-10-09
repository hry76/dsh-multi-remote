/**
 * `src/session/preset.js` 的契约测试。
 *
 * 这一层要挡住的失败模式是本项目**最坏**的那一种：
 * 预设没真的挂上 → 会话**静默留在本机跑**，而界面上显示「已连上远程」。
 *
 * 所以测试重点是：
 *   - 行 name 必须是模块 specifier（绝对路径会让该行永不启动）
 *   - 注册后**必须回读诊断**（宿主激活失败只写 warn、不抛错）
 *   - 不可用时**必须抛错**，绝不返回一个「看起来能用」的对象
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPresetDefinition,
  validatePresetDefinition,
  isModuleSpecifier,
  PresetRegistry,
  PRESET_ID,
  PRESET_ID_PREFIX,
  PLUGIN_PACKAGE,
  ISOLATED_SERVICES,
  ISOLATED_TOOL_ROWS,
} from '../src/session/preset.js'

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')

/** 模拟宿主 `agentPresets` 的关键行为：register 会 await 激活，激活失败不抛错。 */
function fakeAgentPresets(options = {}) {
  const definitions = new Map()
  return {
    /** 测试可以指定某个 id 激活失败。 */
    brokenIds: new Set(options.brokenIds ?? []),
    registerCalls: [],
    async register(definition) {
      this.registerCalls.push(definition.id)
      if (definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
      definitions.set(definition.id, definition)
      let disposed = false
      return async () => {
        if (disposed) return
        disposed = true
        definitions.delete(definition.id)
      }
    },
    async compositionInventory() {
      return [...definitions.keys()].map((id) => ({
        id,
        isDefault: false,
        ...this.brokenIds.has(id) ? { broken: 'row X: never started' } : {},
        rows: this.brokenIds.has(id) ? [] : [{ id: `${id}-world`, state: 'active' }],
      }))
    },
  }
}

test('PRESET_ID：单一远程模式的固定 id，稳定且带前缀', () => {
  assert.equal(PRESET_ID, 'multi-remote')
  assert.match(PRESET_ID, new RegExp(`^${PRESET_ID_PREFIX}$`))
  // 负对照：id 按「档案+远程根」派生 → 每个项目一个预设，模式列表出现 N 个「远程模式」
})

test('isModuleSpecifier：放行包名与包子路径，拒绝路径与 URL', () => {
  assert.equal(isModuleSpecifier('@jk-uzi/dsh-multi-remote/world/fs.js'), true)
  assert.equal(isModuleSpecifier('some-pkg'), true)
  assert.equal(isModuleSpecifier('some-pkg/sub.js'), true)

  // 这些都会让预设行永不启动（被当成 URL 协议或相对路径）
  assert.equal(isModuleSpecifier('D:/x/y.js'), false)
  assert.equal(isModuleSpecifier('D:\\x\\y.js'), false)
  assert.equal(isModuleSpecifier('/abs/y.js'), false)
  assert.equal(isModuleSpecifier('./rel.js'), false)
  assert.equal(isModuleSpecifier('../rel.js'), false)
  assert.equal(isModuleSpecifier('file:///x.js'), false)
  assert.equal(isModuleSpecifier(''), false)
  // 负对照：把 isModuleSpecifier 恒返回 true，绝对路径会被放过 ——
  // 实测后果是诊断显示 never started、entry.fiber === undefined，插件看似挂上实则没跑
})

test('buildPresetDefinition：行 name 是可解析的模块 specifier，绝不是文件路径', () => {
  const definition = buildPresetDefinition()
  const group = definition.plugins[0]
  assert.equal(group.name, 'cordis:group')
  assert.equal(group.group, true)
  assert.deepEqual(Object.keys(group.isolate), ISOLATED_SERVICES)
  assert.ok(group.isolate.fs === true && group.isolate.shell === true, 'fs 与 shell 必须都隔离')

  for (const row of group.config) {
    if (!row.name.startsWith(`${PLUGIN_PACKAGE}/`)) continue
    assert.ok(isModuleSpecifier(row.name), `行的 name 必须是模块 specifier：${row.name}`)
    // 方案 A：provider 行**不再注入 profileId/remoteRoot**（按路径动态路由）
    assert.equal(row.config, undefined, `provider 行不再注入 config：${row.name}`)
  }
  for (const row of ISOLATED_TOOL_ROWS) {
    assert.ok(isModuleSpecifier(row.name), `工具行的 name 也必须是模块 specifier：${row.name}`)
  }
  assert.deepEqual(validatePresetDefinition(definition), [], '构造出来的定义必须自洽')
  assert.equal(definition.id, PRESET_ID, '预设 id 固定为单一远程模式')
  // 负对照：把行 name 换成 path.join(__dirname, ...)，validatePresetDefinition 会报错
})

test('buildPresetDefinition：shell 工具必须在隔离域内注册（否则命令落在本机）', () => {
  // 实测发现的关键事实：`agent.ctx` 解析到的是**全局**（本机）ctx.shell，
  // 所以「让命令落在远程」只能靠**在我们自己的隔离域里注册工具** ——
  // 域内的 ctx.shell 才是远程实现。
  //
  // 反过来说：不在域内注册工具，远程会话就**根本没有能跑命令的工具**
  // （默认预设的 tool-pwsh/tool-bash 随它自己的 scope 走，不在我们域内）。
  const definition = buildPresetDefinition()
  const group = definition.plugins[0]
  const toolRows = group.config.filter((row) => !row.name.startsWith(`${PLUGIN_PACKAGE}/`))

  assert.ok(toolRows.length >= 1, '隔离域内至少要有一个 shell 工具行')
  assert.ok(
    toolRows.some((row) => row.name === '@deepseek-ai/dsh-tool-bash'),
    '必须有 bash 工具行，且它要挂在我们域的 provider 之后',
  )
  // 工具行必须在**组内**（域内），不能挂在组外的 plugins 顶层
  assert.ok(
    !definition.plugins.some((row) => row.name === '@deepseek-ai/dsh-tool-bash'),
    '工具行不能挂在域外 —— 域外会解析到全局 ctx.shell，命令会落在本机',
  )
  // 负对照：把工具行挪到 plugins 顶层，第二条断言变红，
  // 而真实后果是「已连上远程的会话把命令跑在本机」
})

test('buildPresetDefinition：bash 工具行不再注入 cwd（靠 world-shell 按锚点路由）', () => {
  // 方案 A：单一远程模式没有固定的远程根，无法给 bash 配一个 cwd。
  // 改为**不注入 cwd** —— tool-bash 默认用会话 cwd（本机锚点目录），
  // world-shell 会把它翻译成远程根并路由到正确连接（实测那条翻译路径已通）。
  const definition = buildPresetDefinition()
  const rows = definition.plugins[0].config

  const bash = rows.find((row) => row.name === '@deepseek-ai/dsh-tool-bash')
  assert.ok(bash !== undefined, '必须有 bash 工具行')
  assert.equal(bash.config, undefined, 'bash 不再注入固定 cwd（单一远程模式没有唯一远程根）')
  // 负对照：硬塞一个 cwd 会让 bash 在错误的项目根跑（单预设不知道该填哪个）
})

// ── 预设必须与宿主默认预设对齐（2026-10-07 实测发现的大缺口）──────
//
// 原来只有 5 行（pty + 3 个 provider + tool-bash），于是**远程会话里模型只有
// bash 和终端**：不能读文件、不能写文件、不能编辑、不能搜索，也读不到 AGENTS.md。
// 为什么之前 4 次真机端到端都没发现：判据一直是「用 **bash 工具**跑一条命令」，
// 而 bash 恰好是挂上的那个 —— 「文件工具没挂」从来没被触发过。

test('读/写/编辑工具（tool-fs）必须在隔离域内 —— 否则改的是本机', () => {
  // `tool-fs` 只注入 `fs`。挂在隔离域内 → 拿到我们的远程实现；
  // 挂在域外 → 拿到全局（本机）实现 → **改的是本地镜像，远程毫无变化**。
  // 这正是本项目最怕的失败模式：看起来成功了，其实什么都没落到远程。
  const definition = buildPresetDefinition()
  const rows = definition.plugins[0].config
  const fsTool = rows.find((row) => row.name === '@deepseek-ai/dsh-tool-fs')

  assert.ok(fsTool !== undefined, '必须有 tool-fs（读文件 / 写文件 / 编辑）')
  assert.ok(
    !definition.plugins.some((row) => row.name === '@deepseek-ai/dsh-tool-fs'),
    'tool-fs 不能挂在域外 —— 域外会解析到全局 ctx.fs，改动落在本机镜像',
  )
  // provider 必须排在工具之前（工具注册时就要解析到域内实现）
  const fsIndex = rows.findIndex((row) => row.name.endsWith('/world/fs.js'))
  const fsToolIndex = rows.findIndex((row) => row.name === '@deepseek-ai/dsh-tool-fs')
  assert.ok(fsIndex >= 0 && fsIndex < fsToolIndex, 'world/fs provider 必须排在 tool-fs 之前')
  // 负对照：把 tool-fs 挪到 plugins 顶层 → 第二条断言变红；
  //          真实后果是「模型以为改了远程，其实只改了本地镜像」
})

test('预设必须覆盖默认预设里的各项能力（逐项对照）', () => {
  // 宿主的默认预设 `ptc` 有 13 行。我们**不要求逐字一样**，但能力不能缺。
  const definition = buildPresetDefinition()
  const names = new Set()
  const collect = (rows) => {
    for (const row of rows ?? []) {
      if (typeof row.name === 'string') names.add(row.name)
      if (Array.isArray(row.config)) collect(row.config)
    }
  }
  collect(definition.plugins)

  // 期望覆盖的能力（宿主默认预设的对应包名）
  const required = [
    '@deepseek-ai/dsh-tool-fs', // 读 / 写 / 编辑
    '@deepseek-ai/dsh-agent-instructions', // AGENTS.md
    '@deepseek-ai/dsh-persona', // 人设
    '@deepseek-ai/dsh-tool-jobs', // 后台任务
    '@deepseek-ai/dsh-skill-filesystem', // 技能目录
    '@deepseek-ai/dsh-tool-skill', // 技能工具
    '@deepseek-ai/dsh-tool-goal', // 目标
    '@deepseek-ai/dsh-command-goal', // /goal 命令
    '@deepseek-ai/dsh-plan-mode', // 计划模式
  ]
  for (const pkg of required) {
    assert.ok(names.has(pkg), `预设缺少能力行：${pkg}（远程会话里这项功能会整个消失）`)
  }

  // 搜索：**刻意不用宿主那份** —— 它跑在本机、搜的是本地镜像。
  // 我们挂自己的 `world/search.js`（在域内用远程的 find/grep）。
  assert.ok(
    !names.has('@deepseek-ai/dsh-tool-fs-search'),
    '不该挂宿主的 tool-fs-search —— 它用打包在宿主里的 ripgrep 跑在本机，搜的是本地镜像',
  )
  assert.ok(
    names.has(`${PLUGIN_PACKAGE}/world/search.js`),
    '必须有我们自己的远程搜索 provider（提供 glob / grep）',
  )

  // 刻意**不**包含 pwsh：远程是 Linux，没有 pwsh
  assert.ok(!names.has('@deepseek-ai/dsh-tool-pwsh'), '远程不该挂 pwsh（目标环境是 Linux）')
  // 负对照：期望集合留空 → 测试变成永远通过的空壳
  assert.ok(required.length >= 9)
})

test('计划模式要按默认预设那样单独 isolate 一层', () => {
  const definition = buildPresetDefinition()
  const planning = definition.plugins[0].config.find((row) => row.id === 'planning')
  assert.ok(planning !== undefined, '要有 planning 组')
  assert.equal(planning.name, 'cordis:group')
  assert.equal(planning.group, true)
  assert.deepEqual(planning.isolate, { planMode: true })
  assert.ok(
    planning.config.some((row) => row.name === '@deepseek-ai/dsh-plan-mode'),
    'plan-mode 要挂在 planning 组里',
  )
  // 负对照：把 plan-mode 平铺到外层 → 与默认预设的结构不一致，
  //          planMode 服务会与全局的那份串味
})

test('buildPresetDefinition：provider 必须排在工具行之前', () => {
  // 工具在注册时就要解析 ctx.shell。provider 排在后面的话，
  // 工具可能先解析到全局实现（本机），随后才轮到我们的 provider 上线。
  const definition = buildPresetDefinition()
  const rows = definition.plugins[0].config
  const fsIndex = rows.findIndex((row) => row.name.endsWith('/world/fs.js'))
  const shellIndex = rows.findIndex((row) => row.name.endsWith('/world/shell.js'))
  const toolIndex = rows.findIndex((row) => row.name === '@deepseek-ai/dsh-tool-bash')

  assert.ok(fsIndex >= 0 && shellIndex >= 0 && toolIndex >= 0)
  assert.ok(shellIndex < toolIndex, 'shell provider 必须排在 shell 工具之前')
  // 负对照：把工具行插到最前面，顺序断言变红
})

test('预设里引用的每个本插件子路径都必须在 package.json 的 exports 里登记', () => {
  // 实测踩到过：新增 `world/search.js` 这一行后忘了往 `package.json` 的
  // `exports` 加对应条目 —— 宿主解析不到模块，该行报 **`never started`**，
  // 而**整行 broken 会让整个预设激活失败**（我们的 fail-loud 直接拒绝建连）。
  // 症状很难猜（不报「文件不存在」，只说 never started），所以静态拦住。
  const definition = buildPresetDefinition()
  const specifiers = new Set()
  const collect = (rows) => {
    for (const row of rows ?? []) {
      if (typeof row.name === 'string' && row.name.startsWith(`${PLUGIN_PACKAGE}/`)) specifiers.add(row.name)
      if (Array.isArray(row.config)) collect(row.config)
    }
  }
  collect(definition.plugins)

  assert.ok(specifiers.size >= 3, `应当解析出多个子路径，实际：${[...specifiers].join(', ')}`)

  const pkg = JSON.parse(read('package.json'))
  for (const specifier of specifiers) {
    const subpath = `.${specifier.slice(PLUGIN_PACKAGE.length)}`
    assert.ok(
      pkg.exports[subpath] !== undefined,
      `${specifier} 没在 package.json 的 exports 里 —— 宿主会报 never started，整个预设激活失败`,
    )
    // 顺带确认文件真的在
    const target = String(pkg.exports[subpath].default ?? '').replace(/^\.\//, '')
    assert.ok(existsSync(join(ROOT, target)), `exports 指向的 ${target} 不存在`)
  }
  // 负对照：不加这条闸门 → 下一次「新增 provider 行」还会再犯一次同样的错
})

test('validatePresetDefinition：抓出绝对路径、相对路径与点号 id', () => {
  const base = buildPresetDefinition()

  const withAbsolute = structuredClone(base)
  withAbsolute.plugins[0].config[0].name = 'D:/Users/someone/plugin/src/world/fs.js'
  const problems = validatePresetDefinition(withAbsolute)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /必须是模块 specifier/)
  // 负对照：不做这项校验，绝对路径会被原样交给宿主 → 该行永不启动，且只给一句诊断

  const withRelative = structuredClone(base)
  withRelative.plugins[0].config[0].name = './world/fs.js'
  assert.match(validatePresetDefinition(withRelative)[0], /必须是模块 specifier/)

  const withDotId = structuredClone(base)
  withDotId.id = 'multi.remote.x'
  assert.match(validatePresetDefinition(withDotId)[0], /不能含点号/)

  const withEmptyName = structuredClone(base)
  withEmptyName.plugins[0].config[0].name = ''
  assert.match(validatePresetDefinition(withEmptyName)[0], /name 必须是非空字符串/)

  assert.deepEqual(validatePresetDefinition({ id: 'x', plugins: 'not-an-array' }), ['plugins 必须是数组'])
})

test('PresetRegistry：注册后回读诊断，激活失败必须可见', async () => {
  const agentPresets = fakeAgentPresets({ brokenIds: [PRESET_ID] })
  const warnings = []
  const registry = new PresetRegistry({ agentPresets, log: (message, ...rest) => warnings.push([message, ...rest]) })

  const definition = buildPresetDefinition()

  const diagnostic = await registry.register(definition)
  assert.equal(diagnostic.present, true)
  assert.equal(diagnostic.usable, false, '激活失败的预设必须被判为不可用')
  assert.match(diagnostic.broken, /never started/)
  assert.equal(warnings.length, 1, '必须写一条 warn，不静默')
  // 负对照：register() 里不回读诊断，diagnostic.usable 无从得知 ——
  // 我们会以为挂上了，而会话其实在本机跑
})

test('PresetRegistry：干净注册时可用，且不写 warn', async () => {
  const agentPresets = fakeAgentPresets()
  const warnings = []
  const registry = new PresetRegistry({ agentPresets, log: (message, ...rest) => warnings.push([message, ...rest]) })

  const definition = buildPresetDefinition()
  const diagnostic = await registry.register(definition)

  assert.equal(diagnostic.usable, true)
  assert.equal(diagnostic.broken, undefined)
  assert.equal(warnings.length, 0)
  assert.deepEqual(registry.registeredIds, [definition.id])
  // 负对照：把 usable 判据写成 `row !== undefined`（不看 broken），
  // 上面那条「激活失败」的测试会误判为可用
})

test('PresetRegistry.assertUsable：不可用时抛错，绝不返回「看起来能用」', async () => {
  const agentPresets = fakeAgentPresets()
  const registry = new PresetRegistry({ agentPresets })
  const definition = buildPresetDefinition()
  await registry.register(definition)

  // 注册表里没有 → 抛错
  await assert.rejects(() => registry.assertUsable('不存在的预设'), /不在注册表里/)

  // 激活失败 → 抛错，并且文案明确说「拒绝在本机降级运行」
  agentPresets.brokenIds.add(definition.id)
  await assert.rejects(() => registry.assertUsable(definition.id), /拒绝在本机降级运行/)

  // 正常 → 返回诊断
  agentPresets.brokenIds.delete(definition.id)
  const diagnostic = await registry.assertUsable(definition.id)
  assert.equal(diagnostic.usable, true)
  // 负对照：assertUsable 只检查「存在」，激活失败的预设会被放行 →
  // 会话开起来但 agent 在本机跑，界面上却显示已连上远程
})

test('PresetRegistry：重复注册同一个 id 直接抛错', async () => {
  const agentPresets = fakeAgentPresets()
  const registry = new PresetRegistry({ agentPresets })
  const definition = buildPresetDefinition()
  await registry.register(definition)

  await assert.rejects(() => registry.register(definition), /已经注册过/)
  // 负对照：不挡重复注册，宿主会抛 Duplicate agent preset，
  // 但那时我们可能已经改了别的状态，回滚不干净
})

test('PresetRegistry：注销干净，且可以从注册表移除', async () => {
  const agentPresets = fakeAgentPresets()
  const registry = new PresetRegistry({ agentPresets })
  const definition = buildPresetDefinition()
  await registry.register(definition)
  assert.deepEqual(registry.registeredIds, [definition.id])

  assert.equal(await registry.unregister(definition.id), true)
  assert.deepEqual(registry.registeredIds, [])
  assert.equal(await registry.unregister(definition.id), false, '重复注销返回 false，不抛错')

  const inventory = await agentPresets.compositionInventory()
  assert.equal(inventory.length, 0, '宿主侧也必须真的没了')
  // 负对照：不调用宿主的 disposer，插件卸载后预设会留在注册表里，
  // 重新挂载时撞 Duplicate agent preset
})

test('PresetRegistry.ensureRegistered：幂等 —— 多个连接共享同一份预设，只注册一次', async () => {
  const agentPresets = fakeAgentPresets()
  const registry = new PresetRegistry({ agentPresets })
  const definition = buildPresetDefinition()

  const first = await registry.ensureRegistered(definition)
  assert.equal(first.usable, true)
  const second = await registry.ensureRegistered(definition)
  assert.equal(second.usable, true)

  assert.deepEqual(registry.registeredIds, [PRESET_ID], '只注册一份')
  assert.equal(agentPresets.registerCalls.length, 1, '宿主的 register 只被调一次')
  // 负对照：每次连接都 register 同一个 id → 第二个连接撞 Duplicate agent preset
})

test('PresetRegistry.unregisterAll：一次清干净，失败也继续', async () => {
  const agentPresets = fakeAgentPresets()
  const registry = new PresetRegistry({ agentPresets })
  await registry.register(buildPresetDefinition())
  assert.equal(registry.registeredIds.length, 1)

  const summary = await registry.unregisterAll()
  assert.equal(summary.removed, 1)
  assert.equal(summary.failed, 0)
  assert.deepEqual(registry.registeredIds, [])
  // 负对照：用串行 await 且不 catch，第一个失败会让后面的预设留在注册表里
})
