/**
 * 界面路由辅助（`src/http/ui-routes.js`）的契约测试。
 *
 * 这一层是**浏览器里的代码**与宿主之间的边界，所以两条红线必须有测试钉住：
 *
 *   1. **白名单**：界面发来的字段里，不认识的必须丢掉，绝不整包往下传
 *   2. **凭据不回显**：密码 / 私钥路径可以传进来（SSH 绕不开），
 *      但**任何**回给界面的结构里都不能带上它们
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  readJsonBody,
  normalizeConnectRequest,
  describeProfiles,
  describeConnected,
  SENSITIVE_FIELDS,
  deriveConnectId,
  workspaceTitle,
  normalizeClientReport,
  normalizeSettingsPatch,
  MAX_BODY_BYTES,
} from '../src/http/ui-routes.js'

/** 造一个能喂 data/end 的最小 req。 */
function fakeReq(chunks) {
  const req = new EventEmitter()
  req.destroy = () => {}
  setImmediate(() => {
    for (const chunk of chunks) req.emit('data', Buffer.from(chunk))
    req.emit('end')
  })
  return req
}

// ── readJsonBody ─────────────────────────────────────────────────────────────

test('readJsonBody：正常 JSON、空 body、超限、坏 JSON', async () => {
  assert.deepEqual(await readJsonBody(fakeReq(['{"a":1}'])), { a: 1 })
  // 空 body 当空对象 —— 界面上的「打开文件夹」就是发一个空 POST
  assert.deepEqual(await readJsonBody(fakeReq([])), {})
  assert.deepEqual(await readJsonBody(fakeReq(['   '])), {})

  await assert.rejects(() => readJsonBody(fakeReq(['{oops'])), /不是合法的 JSON/)

  // 超限要**拒绝**，不是截断后当成合法 JSON
  const huge = 'x'.repeat(MAX_BODY_BYTES + 10)
  await assert.rejects(() => readJsonBody(fakeReq([huge])), /超过/)
  // 负对照：不设上限 → 一个超大 body 就能把宿主内存吃掉
})

// ── normalizeConnectRequest：白名单 ──────────────────────────────────────────

test('normalizeConnectRequest：不认识的字段一律丢掉（白名单）', () => {
  const input = normalizeConnectRequest({
    kind: 'wsl',
    distro: 'Ubuntu-24.04',
    remoteRoot: '/home/user/proj',
    // 下面这些都不在白名单里 —— 一个都不能透传
    __proto__: { polluted: true },
    constructor: 'evil',
    anchorParentEvil: '/etc',
    command: 'rm -rf /',
    extra: { deep: true },
    toJSON: 'nope',
  })
  assert.deepEqual(Object.keys(input).sort(), ['distro', 'kind', 'remoteRoot'])
  assert.equal(input.command, undefined)
  assert.equal(input.extra, undefined)
  assert.equal(input.anchorParentEvil, undefined)
  // 负对照：整包透传 → 界面（浏览器里的代码）能往连接内部塞任意字段
})

test('normalizeConnectRequest：kind 默认 ssh，未知 kind 报清楚', () => {
  const ssh = normalizeConnectRequest({ host: 'h', username: 'u', remoteRoot: '/p' })
  assert.equal(ssh.kind, 'ssh')

  assert.throws(
    () => normalizeConnectRequest({ kind: 'telnet', remoteRoot: '/p' }),
    /不支持的后端类型：telnet/,
  )
  // 负对照：未知 kind 当成 ssh 处理 → 用户以为在连 telnet，实际连了别的东西
})

test('normalizeConnectRequest：remoteRoot 必须是绝对 POSIX 路径', () => {
  assert.throws(
    () => normalizeConnectRequest({ kind: 'wsl', distro: 'Ubuntu-24.04' }),
    /远程项目根必须是绝对 POSIX 路径/,
  )
  assert.throws(
    () => normalizeConnectRequest({ kind: 'wsl', distro: 'Ubuntu-24.04', remoteRoot: 'C:\\proj' }),
    /绝对 POSIX 路径/,
  )
  // 负对照：放过相对路径 → 远程侧会在登录目录下乱建东西
})

test('normalizeConnectRequest：按后端校验必填字段', () => {
  assert.throws(() => normalizeConnectRequest({ kind: 'wsl', remoteRoot: '/p' }), /缺少必填字段：distro/)
  assert.throws(() => normalizeConnectRequest({ kind: 'docker', remoteRoot: '/p' }), /缺少必填字段：container/)
  assert.throws(() => normalizeConnectRequest({ kind: 'ssh', remoteRoot: '/p' }), /缺少必填字段：host/)
  assert.throws(
    () => normalizeConnectRequest({ kind: 'ssh', host: 'h', remoteRoot: '/p' }),
    /缺少必填字段：username/,
  )
  // 负对照：不校验 → 界面少填一项，用户在很后面才看到一句看不懂的报错
})

test('normalizeConnectRequest：端口范围与类型', () => {
  assert.equal(normalizeConnectRequest({ kind: 'ssh', host: 'h', username: 'u', remoteRoot: '/p', port: '2222' }).port, 2222)
  assert.equal(normalizeConnectRequest({ kind: 'ssh', host: 'h', username: 'u', remoteRoot: '/p', port: 22 }).port, 22)
  assert.throws(
    () => normalizeConnectRequest({ kind: 'ssh', host: 'h', username: 'u', remoteRoot: '/p', port: '70000' }),
    /1–65535/,
  )
  assert.throws(
    () => normalizeConnectRequest({ kind: 'ssh', host: 'h', username: 'u', remoteRoot: '/p', port: 'abc' }),
    /1–65535/,
  )
  // 负对照：端口不校验 → 一个 NaN 端口到了传输层才炸，报错更难懂
})

test('normalizeConnectRequest：空白字段当成没填（不留空串）', () => {
  const input = normalizeConnectRequest({ kind: 'wsl', distro: '  Ubuntu-24.04  ', remoteRoot: ' /home/user/p ' })
  assert.equal(input.distro, 'Ubuntu-24.04')
  assert.equal(input.remoteRoot, '/home/user/p')

  const noUser = normalizeConnectRequest({ kind: 'ssh', host: 'h', username: 'u', remoteRoot: '/p', privateKeyPath: '   ' })
  assert.equal(noUser.privateKeyPath, undefined)
  // 负对照：把 '   ' 当已填 → 传给传输层一个不存在的私钥路径
})

test('normalizeConnectRequest：非对象直接拒绝', () => {
  assert.throws(() => normalizeConnectRequest(null), /必须是一个 JSON 对象/)
  assert.throws(() => normalizeConnectRequest([]), /必须是一个 JSON 对象/)
  assert.throws(() => normalizeConnectRequest('a'), /必须是一个 JSON 对象/)
})

// ── 凭据不回显（红线）────────────────────────────────────────────────────────

test('凭据可以传进来，但绝不回显给界面', () => {
  const input = normalizeConnectRequest({
    kind: 'ssh',
    host: 'h',
    username: 'u',
    remoteRoot: '/p',
    password: 'hunter2',
    passphrase: 'secret',
    privateKeyPath: 'C:\\keys\\id_ed25519',
  })
  // 传进来是允许的（SSH 绕不开）
  assert.equal(input.password, 'hunter2')
  assert.equal(input.privateKeyPath, 'C:\\keys\\id_ed25519')

  // 但回给界面的结构里一个都不能有
  const described = describeConnected({
    id: 'p1', kind: 'ssh', label: 'L', host: 'h', port: 22, username: 'u',
    remoteRoot: '/p', anchorPath: 'C:\\a', presetId: 'x',
    // 就算上游多给了字段，describe* 也只挑白名单里的键
    password: 'hunter2', privateKey: 'KEY', passphrase: 'secret',
  })
  const json = JSON.stringify(described)
  for (const field of SENSITIVE_FIELDS) {
    assert.ok(!(field in described), `describeConnected 不该包含 ${field}`)
  }
  assert.ok(!json.includes('hunter2'), '不能回显密码')
  assert.ok(!json.includes('KEY'), '不能回显私钥')

  const profiles = describeProfiles([
    { id: 'p1', kind: 'ssh', label: 'L', host: 'h', username: 'u', remoteRoot: '/p', password: 'hunter2', privateKey: 'KEYCONTENT', privateKeyPath: 'C:\\k' },
  ])
  const profilesJson = JSON.stringify(profiles)
  assert.ok(!profilesJson.includes('hunter2'), '档案列表不能回显密码')
  assert.ok(!profilesJson.includes('KEYCONTENT'), '档案列表不能回显私钥内容')

  // 私钥**路径**是**刻意放行**的：它是路径不是凭据（认证不了任何人），
  // 而界面正是靠它把「用过的连接」填满 —— 不放行用户就得重敲一遍。
  // 但它必须是**唯一**放行的认证相关字段：加新字段之前先想清楚。
  assert.equal(profiles[0].privateKeyPath, 'C:\\k', '私钥路径要回显（否则用户得重敲）')
  const authKeys = Object.keys(profiles[0]).filter((key) => /pass|key|agent|secret/i.test(key))
  assert.deepEqual(authKeys.sort(), ['privateKeyPath'], '认证相关字段只允许 privateKeyPath 一个')
  // 负对照：`describe*` 直接 spread 上游对象 → 凭据跟着 JSON 回到浏览器，
  //          而浏览器里可能还有别的脚本
})

test('describeConnected：三种后端的 target 文案', () => {
  assert.equal(describeConnected({ kind: 'wsl', distro: 'Ubuntu-24.04' }).target, 'WSL Ubuntu-24.04')
  assert.equal(describeConnected({ kind: 'docker', container: 'c1' }).target, '容器 c1')
  assert.equal(describeConnected({ kind: 'ssh', username: 'user', host: '10.0.0.1', port: 9492 }).target, 'user@10.0.0.1:9492')
  // 负对照：target 里带上密码 → 它会被写进审计与界面
})

test('normalizeSettingsPatch：只认白名单字段，MiB 换算成字节', () => {
  const patch = normalizeSettingsPatch({
    auditCapacity: 1000,
    mirrorDeepen: { enabled: false, maxFileBytesMiB: 4, maxTotalBytesMiB: 128 },
  })
  assert.equal(patch.auditCapacity, 1000)
  assert.equal(patch.mirrorDeepen.enabled, false)
  assert.equal(patch.mirrorDeepen.maxFileBytes, 4 * 1024 * 1024)
  assert.equal(patch.mirrorDeepen.maxTotalBytes, 128 * 1024 * 1024)

  // 白名单：不认识的字段**直接忽略**，不许进配置
  const sneaky = normalizeSettingsPatch({ auditCapacity: 900, profileStoreDir: '/etc', trustedHosts: ['evil'] })
  assert.deepEqual(Object.keys(sneaky), ['auditCapacity'])
  // 负对照：整包往下传 → 界面（或任何一个 XSS）能改插件的任意配置
})

test('normalizeSettingsPatch：非法值明确抛错，不静默取默认', () => {
  for (const bad of [
    null,
    [],
    'x',
    {},                                   // 什么都没改
    { auditCapacity: 'many' },
    { auditCapacity: 1 },                 // 低于下限
    { auditCapacity: 1.5 },               // 不是整数
    { auditCapacity: 999999 },            // 高于上限
    { mirrorDeepen: 5 },
    { mirrorDeepen: { maxFileBytesMiB: -1 } },
    { mirrorDeepen: { enabled: 'yes' } },
  ]) {
    assert.throws(() => normalizeSettingsPatch(bad), `应当拒绝：${JSON.stringify(bad)}`)
  }
  // 负对照：静默取默认值 → 用户以为保存成功，实际存的是另一个数
})

test('describeProfiles：非数组输入不炸', () => {  assert.deepEqual(describeProfiles(undefined), [])
  assert.deepEqual(describeProfiles(null), [])
  assert.deepEqual(describeProfiles('nope'), [])
})

// ── 客户端自诊断上报 ─────────────────────────────────────────────────────────

test('normalizeClientReport：能收多少收多少，绝不抛错', () => {
  // 上报是**诊断**数据，不是业务请求 —— 畸形输入也不能让路由炸掉，
  // 否则「点 `+` 没反应」这个场景连诊断都发不出来。
  assert.deepEqual(normalizeClientReport({ step: 'flow-open', ok: true }), { step: 'flow-open', ok: true, detail: null })
  assert.deepEqual(normalizeClientReport({}), { step: '(未命名步骤)', ok: false, detail: null })
  assert.deepEqual(normalizeClientReport(null), { step: '(未命名步骤)', ok: false, detail: null })
  assert.deepEqual(normalizeClientReport('nope'), { step: '(未命名步骤)', ok: false, detail: null })
  assert.deepEqual(normalizeClientReport([1, 2]), { step: '(未命名步骤)', ok: false, detail: null })

  // 超长要截断（诊断数据不能把审计的环形缓冲冲掉）
  const long = normalizeClientReport({ step: 's'.repeat(200), detail: 'd'.repeat(1000), ok: 1 })
  assert.equal(long.step.length, 80)
  assert.equal(long.detail.length, 300)
  // `ok: 1` 不是 true —— 严格判定，免得 `'false'` 这种字符串被当成成功
  assert.equal(long.ok, false)
  // 负对照：不截断 → 一条上报能把历史记录全冲掉
})

// ── 自动生成连接 id（界面不要求用户起名）────────────────────────────────────

test('deriveConnectId：后端 + 远程根 → 合法 id（可读前缀 + 12 位哈希）', () => {
  const wsl = deriveConnectId('wsl', '/home/user/proj')
  assert.match(wsl, /^wsl-home-user-proj-[0-9a-f]{12}$/)
  assert.equal(deriveConnectId('ssh', '/srv/app'), deriveConnectId('ssh', '/srv/app'), '同一输入必须稳定')
  assert.match(deriveConnectId('ssh', '/srv/app'), /^ssh-srv-app-[0-9a-f]{12}$/)
  // 大写、点号、下划线、中文都要被清理 —— **id 绝不能含点号**（会进预设 id，实测炸过插件树）
  const messy = deriveConnectId('wsl', '/home/user/My.Project_2026')
  assert.ok(!messy.includes('.'), `不该含点号：${messy}`)
  assert.ok(!messy.includes('_'), `不该含下划线：${messy}`)
  assert.ok(messy.startsWith('wsl-home-user-'))
  // 负对照：直接拿远程根当 id → 大写/点号进预设 id → 插件树加载失败
})

test('deriveConnectId：长公共前缀的两个不同项目**必须**得到不同 id', () => {
  // 2026-10-13 实测事故：只用路径派生（截断到 60）时，长公共前缀的两个项目
  // 会撞同一个 id → 第二个项目 connect 抛「档案 X 已经连接」→「连第二个不能用」。
  const a = deriveConnectId('ssh', `/home/jk/ofwb/${'x'.repeat(60)}/main`)
  const b = deriveConnectId('ssh', `/home/jk/ofwb/${'x'.repeat(60)}/main/of`)
  assert.notEqual(a, b, '截断后也必须能区分')
  assert.ok(a.length <= 60 && b.length <= 60, '长度仍受 60 限制')
  // 负对照：没有哈希后缀 → 前缀相同时必撞（上面两个截断后一模一样）
})

test('deriveConnectId：退化场景不产生空串或怪名字', () => {
  assert.match(deriveConnectId('wsl', '/'), /^wsl-[0-9a-f]{12}$/)
  assert.match(deriveConnectId('wsl', ''), /^wsl-[0-9a-f]{12}$/)
  assert.match(deriveConnectId('docker', '///'), /^docker-[0-9a-f]{12}$/)
  // 超长截断后仍不以 - 结尾，且总长受控
  const long = deriveConnectId('ssh', '/' + 'a'.repeat(200))
  assert.ok(long.length <= 60 && !long.endsWith('-'))
})
// ── 工作区命名：只取最后一层目录 ─────────────────────────────────────────────

test('workspaceTitle：`后端:最后一层目录`（短，且能看出是哪台机器）', () => {
  // 演进（用户三次反馈）：锚点名 → ssh:/data/my-proj/my-proj（太长）→ my-proj（看不出机器）→ 现在
  assert.equal(workspaceTitle('ssh', '/home/user/my-proj/my-proj'), 'ssh:my-proj')
  assert.equal(workspaceTitle('ssh', '/home/user/桌面/demo-app'), 'ssh:demo-app')
  assert.equal(workspaceTitle('wsl', '/home/user/test-proj'), 'wsl:test-proj')
  assert.equal(workspaceTitle('docker', '/app'), 'docker:app')
  assert.equal(workspaceTitle('ssh', '/home/user/桌面/demo-app/'), 'ssh:demo-app', '尾斜杠要能处理')
  // 中文目录名原样保留
  assert.equal(workspaceTitle('ssh', '/home/user/桌面'), 'ssh:桌面')
  // 负对照：只给文件夹名 → 两台机器上都有 `project` 时，侧边栏出现两个一模一样的条目
})

test('workspaceTitle：退化场景不给半截名字', () => {
  assert.equal(workspaceTitle('ssh', '/'), 'ssh', '根目录 → 至少还有后端名，不能是 `ssh:`')
  assert.equal(workspaceTitle('wsl', ''), 'wsl')
  assert.equal(workspaceTitle('', undefined), 'remote')
  // 负对照：返回空串或 `ssh:` → 侧边栏出现没有名字 / 半截名字的工作区
})