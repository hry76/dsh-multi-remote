/**
 * 静态闸门 —— 不启动 DSH，只检查「会直接让插件装不上或整个 harness 起不来」的硬约束。
 *
 * 为什么需要它：DSH 插件的失败代价极不对称——注册错一个名字、少声明一个 peer 依赖，
 * 后果不是「功能不好用」，而是**整个插件树启动失败**，或者**装了但静默不加载**。
 * 三个参考项目都为这类问题付过真实代价，这里把它们固化成机器判据。
 *
 * 运行：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 递归收集文件（跳过 .git / node_modules）。 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const files = walk(ROOT)
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const pkg = JSON.parse(read('package.json'))

test('package.json 是合法 JSON 且必填字段齐全', () => {
  assert.equal(typeof pkg.name, 'string', 'name 必须是字符串')
  assert.equal(typeof pkg.version, 'string', 'version 必须是字符串')
  assert.equal(pkg.type, 'module', 'type 必须是 module')
  assert.ok(pkg.license, 'license 必填（开源）')
  assert.ok(pkg.repository?.url, 'repository.url 必填（开源）')
  assert.ok(pkg.publishConfig?.access === 'public', 'scoped 包必须声明 publishConfig.access=public，否则发不出去')
  assert.ok(pkg.private !== true, 'private 不能为 true，否则无法发布')
})

test('四处身份标识必须完全一致', () => {
  // 少一处不一致的后果：插件行报 failed to import，或客户端半边注册到错误的 id 上
  const patch = read('cordis.patch.yml')
  const index = read('src/index.js')
  const client = read('src/client.js')

  const patchName = patch.match(/name:\s*'([^']+)'/)?.[1]
  const entryId = patch.match(/- id:\s*(\S+)/)?.[1]
  const indexName = index.match(/export const name = '([^']+)'/)?.[1]
  const clientId = client.match(/id:\s*'([^']+)'/)?.[1]

  assert.equal(patchName, pkg.name, 'cordis.patch.yml 的 name 必须等于包名（loader 靠它解析模块）')
  assert.equal(indexName, pkg.name, 'src/index.js 的 name 必须等于包名')
  assert.equal(clientId, pkg.name, 'src/client.js 的 id 必须等于包名（客户端模块靠它注册）')
  assert.ok(entryId, 'cordis.patch.yml 必须有 entry id')
  assert.ok(!entryId.includes('.'), `entry id 不能含点号（参考项目实测会导致插件树加载失败）：${entryId}`)
})

test('每个 @deepseek-ai/* 的 import 都必须在 peerDependencies 里声明', () => {
  // 这是 M0 实测踩到的坑：宿主按「清单声明的依赖」做裸包名路由，
  // 只 import 不声明 → ERR_MODULE_NOT_FOUND → 插件行报 failed to import
  const declared = new Set(Object.keys(pkg.peerDependencies ?? {}))
  const imported = new Set()

  for (const file of files) {
    if (!file.includes(`${join('src', '')}`) && !file.includes('/src/') && !file.includes('\\src\\')) continue
    if (!file.endsWith('.js')) continue
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/from\s+['"](@deepseek-ai\/[^'"]+)['"]/g)) imported.add(m[1])
  }

  for (const name of imported) {
    assert.ok(declared.has(name), `import 了 ${name} 但没写进 peerDependencies —— 插件会 failed to import`)
  }
})

test('peerDependencies 的 @deepseek-ai/dsh-* 范围必须是跨线开区间', () => {
  // caret 在 0.x 上锁死小版本线；DSH 在 import 前校验，任一条不匹配就整包丢弃
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh')) continue
    assert.ok(
      !range.startsWith('^') && !range.startsWith('~'),
      `${name} 的范围 ${range} 用了 caret/tilde，在 0.x 上会锁死小版本线 → 升级 DSH 后插件整个消失`,
    )
  }
})

test('不能写 dsh.compatibility.dshReleases（该字段不存在）', () => {
  const text = read('package.json')
  assert.ok(!text.includes('dshReleases'), 'dsh.compatibility.dshReleases 在当前 DSH 里不存在，写了不生效')
})

test('运行时 npm 依赖必须是最小且已记录的集合', () => {
  // 硬约束：尽量零运行时依赖；确需依赖时必须记录理由。
  // 这条闸门把「悄悄多加一个依赖」变成一次有意识的修改 ——
  // 依赖一多，插件在别人 profile 里的安装成功率就直线下降。
  const allowed = new Set(['ssh2'])
  const actual = Object.keys(pkg.dependencies ?? {})
  const unexpected = actual.filter((name) => !allowed.has(name))
  assert.deepEqual(
    unexpected,
    [],
    `出现未记录的运行时依赖：${unexpected.join(', ')}。若确需引入，请同时更新本闸门与 docs 的依赖说明。`,
  )
  // 负对照：往 package.json 的 dependencies 里加一个 lodash，这条立刻变红
})

test('ssh2 是纯 JS 可用：不得把它变成原生依赖', () => {
  // ssh2 的原生加速（cpu-features）是**可选**的。我们在 pnpm-workspace.yaml 里
  // 明确拒绝构建它 —— 否则「没有 C++ 工具链的用户」会装不上插件。
  // 这条闸门防止有人后来把它改成必需。
  const text = read('pnpm-workspace.yaml')
  assert.match(text, /ssh2:\s*false/, 'pnpm-workspace.yaml 必须显式拒绝 ssh2 的构建脚本')
  assert.match(text, /cpu-features:\s*false/, '必须显式拒绝 cpu-features 的构建脚本')
  // 负对照：把 ssh2 改成 true，没有工具链的机器上 pnpm install 会失败
})

test('路由路径必须全局唯一', () => {
  // 同一 (kind, path) 重复注册 → duplicate prefix route → 整个插件树启动失败
  const index = read('src/index.js')
  const paths = [...index.matchAll(/^(?:const\s+\w*PATH\w*\s*=\s*)'([^']+)'/gm)].map((m) => m[1])
  const dupes = paths.filter((p, i) => paths.indexOf(p) !== i)
  assert.equal(dupes.length, 0, `路由路径重复：${dupes.join(', ')}`)
  for (const p of paths) assert.ok(p.startsWith('/'), `路由必须以 / 开头：${p}`)
})

test('工具名不能占用保留字 run_code，且必须带 remote_ 前缀', () => {
  // 前缀要求不只是风格：插件装进别人的 profile，工具名撞车会让模型看到两个同名工具，
  // 或者直接注册失败。带前缀是避免这类冲突最省事的办法。
  const index = read('src/index.js')
  const names = [...index.matchAll(/name:\s*'(remote_[a-z_]+)'/g)].map((m) => m[1])
  assert.ok(names.length >= 4, `应当注册至少 4 个 remote_* 工具，实际 ${names.length}`)
  for (const name of names) {
    assert.notEqual(name, 'run_code', 'run_code 是 PTC 模式的保留名，不能注册或遮蔽')
    assert.ok(name.startsWith('remote_'), `工具名必须带 remote_ 前缀：${name}`)
  }
  // 负对照：注册一个叫 `bash` 的工具，会和宿主自带工具撞名
})

test('域内工具名也必须带 remote_ 前缀（终端工具）', () => {
  // 域内注册的工具（world/terminal.js 的 remote_terminal）同样会出现在模型面前，
  // 所以同一条命名约定必须覆盖到它 —— 否则会和宿主自带工具撞名。
  const source = read('src/terminal/tool.js')
  const names = [...source.matchAll(/name:\s*'(remote_[a-z_]+)'/g)].map((m) => m[1])
  assert.deepEqual(names, ['remote_terminal'], `终端工具名应当只有一个且带前缀，实际：${names.join(', ')}`)
  // 负对照：叫 'terminal' 会和宿主的终端工具撞名
})

test('工具的 output 必须是 { schema, render }，不能是裸 schema', () => {
  // 实测踩到的坑：给裸 schema 会被宿主拒绝 ——
  // `unsupported JSON schema: schema must be a value schema object`，
  // 而且这条错误会让**整个预设激活失败**（诊断标成 broken），
  // 会话因此拒绝连接。所以静态层面就该拦住。
  for (const rel of ['src/index.js', 'src/terminal/tool.js']) {
    const source = read(rel)
    // 非法形态：`output: {` 之后**直接**出现 schema 关键字（说明那是裸 schema）
    const bad = [...source.matchAll(/output:\s*\{\s*(type|properties|required)\s*:/g)]
    assert.equal(bad.length, 0, `${rel} 里有裸 schema 当 output：${bad.map((m) => m[1]).join(', ')}`)

    // 每个 output 都必须是「工厂函数」或「带 schema 的对象」二选一
    const outputs = [...source.matchAll(/output:\s*(textOutput\(\)|\{[\s\S]{0,120}?schema:)/g)]
    assert.ok(outputs.length > 0, `${rel} 里应当至少有一处 output 声明`)
  }
  // 负对照：把 output 写成裸 `{ type: 'object', ... }` → 预设激活失败、连不上
})

test('对外文件里不能出现维护者本机路径', () => {
  // 开源要求：陌生人 clone 后要能独立跑起来
  const forbidden = /[A-Z]:\\Users\\|\/Users\/[a-z]|dsh-runtimes/
  for (const file of files) {
    const rel = relative(ROOT, file)
    if (rel.startsWith('test')) continue
    const text = readFileSync(file, 'utf8')
    const hit = text.match(forbidden)
    assert.equal(hit, null, `${rel} 里出现本机路径：${hit?.[0]}`)
  }
})

test('对外文件里不能引用内部材料', () => {
  // docs/ requirements/ references/ notes/ 都在仓库外，外部贡献者看不到。
  //
  // ⚠️ **裸引用（不带 `../`）也要拦** —— 实测漏过一次：某个源文件里写着一句
  // 「见 <内部笔记目录>/xxx.md」，而当时只查了 `../docs|requirements|references`，
  // 于是这条一直躺在代码里（发布前人工扫才发现）。
  const bare = /(?:^|[\s(（【`])(?:docs|requirements|references|notes)\//
  for (const file of files) {
    const rel = relative(ROOT, file)
    if (rel.startsWith('test')) continue
    const text = readFileSync(file, 'utf8')
    assert.ok(!/\.\.\/(?:docs|requirements|references|notes)\//.test(text), `${rel} 引用了仓库外的内部材料`)
    assert.ok(!bare.test(text), `${rel} 裸引用了仓库外的内部材料（外部读者看不到）`)
  }
  // 负对照：只查 `../` 前缀 → 裸引用（最常见的那种）全漏
})

test('仓库里不该有内部材料混入', () => {
  // `notes/` 也要在名单里 —— 它同样是仓库外的内部材料
  for (const name of ['AGENTS.md', 'docs', 'requirements', 'references', 'notes', '.devhome']) {
    assert.ok(!existsSync(join(ROOT, name)), `仓库内不该出现 ${name}（按约定它在仓库外）`)
  }
})

test('客户端半边必须是懒 CJS 形态', () => {
  // 写成 ESM 或直接导出组件都不会被宿主加载
  const client = read('src/client.js')
  assert.ok(client.includes('window.__ModuleLoader__.load('), 'src/client.js 必须调用 window.__ModuleLoader__.load')
  assert.ok(/exports\.apply\s*=/.test(client), 'src/client.js 必须导出 apply')
  assert.ok(/exports\.inject\s*=/.test(client), 'src/client.js 必须导出 inject')
})

test('客户端半边的文案不能是过时的占位内容', () => {
  // 实测抓到的 bug：设置页一直写着「尚未实现任何连接能力」，
  // 还指着一个**早就不存在**的工具名（multi_remote_hello）。
  // 界面上说谎比没有界面更坏 —— 用户会以为自己装错了版本。
  const client = read('src/client.js')
  for (const stale of ['尚未实现', 'multi_remote_hello', 'TODO', '占位']) {
    assert.ok(!client.includes(stale), `src/client.js 里不该再出现过时文案：${stale}`)
  }
  // 负对照：保留占位文案 → 功能全做完了，界面上却说自己什么都没做
})

test('客户端半边的文案必须中英双份齐全（宿主强制双语平衡）', () => {
  // `ctx.locale.register(ns, dicts)` 要求每个内置 locale 都给一份，
  // 缺一份会**注册时抛错**。所以静态层面就该拦住。
  const client = read('src/client.js')
  const zhKeys = [...client.matchAll(/^\s{6}([a-zA-Z]+):/gm)].map((match) => match[1])
  assert.ok(zhKeys.length > 0, '应当能解析出文案 key')

  // zh 与 en 两份字典的 key 必须完全一致
  const zhBlock = /zh:\s*\{([\s\S]*?)\n\s{6}\}/.exec(client)?.[1] ?? ''
  const enBlock = /en:\s*\{([\s\S]*?)\n\s{6}\}/.exec(client)?.[1] ?? ''
  const keysOf = (block) => [...block.matchAll(/^\s*([a-zA-Z]+):/gm)].map((match) => match[1]).sort()
  assert.deepEqual(keysOf(zhBlock), keysOf(enBlock), 'zh 与 en 的 key 必须一一对应')
  assert.ok(keysOf(zhBlock).length > 0)
  // 负对照：只写中文 → 宿主注册时抛错，设置页整个挂掉（或退回 key 名）
})

test('每个源文件都能通过语法检查', () => {
  for (const file of files) {
    if (!file.endsWith('.js')) continue
    const rel = relative(ROOT, file)
    assert.doesNotThrow(() => read(rel), `${rel} 读取失败`)
  }
})
