/**
 * 客户端半边（`src/client.js`）的静态契约测试。
 *
 * 客户端代码在浏览器里跑，这个仓库没有 DOM 测试环境，所以这里只钉**结构**：
 * 该注册什么、不该干什么、字符串常量有没有和宿主漂移。
 *
 * 这些看起来很「形式」的断言，每一条都对应一个真实的翻车方式：
 *   - 路由常量写错 → 界面点了没反应，控制台一堆 404
 *   - 忘了失败回退 → 用户点 `+` 什么都不发生（等于把官方功能搞废）
 *   - 不看开关就接管 → 用户关不掉，只能卸载插件
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ROUTE_UI_OPTIONS, ROUTE_UI_CONNECT } from '../src/http/ui-routes.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const client = readFileSync(join(ROOT, 'src/client.js'), 'utf8')

/**
 * 剥掉整行注释后的源码 —— **结构性断言必须用这份**。
 *
 * 实测踩到：注释里解释了「上一版写成了 `xxx.then(...)`」，结果断言在注释里
 * 匹配到了 `.then(`，把一条正确的代码判成错的。注释不是代码。
 */
const clientCode = client
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')

test('客户端：路由常量与宿主一致（不许各写各的）', () => {
  // ⚠️ `pick-directory` 曾经也在这个列表里 —— 那时客户端用它「打开本机文件夹」。
  // 那个动作已移出（本地的操作不属于远程开发），两边都不再引用它。
  for (const route of [ROUTE_UI_OPTIONS, ROUTE_UI_CONNECT]) {
    assert.ok(client.includes(`'${route}'`), `client.js 里应当出现 ${route}`)
  }
  // 负对照：两边各写一份字面量 → 改了一边忘了另一边，界面 404 且没人知道为什么
})

test('客户端：入口走**加法槽位**，绝不碰 `+` 按钮的目录流程', () => {
  // ⚠️⚠️ 这条是**真机事故**换来的（2026-10-07，用户的 DSH 打不开）：
  //
  // 第一版占住了 `+` 按钮的目录流程（`sidebar.workspaces.directoryFlow`）。
  // 那个洞**已经有官方归属** —— 桌面端的「打开文件夹」由官方插件
  // `@deepseek-ai/dsh-client-ui-directory-picker-native` 提供。
  // 我们一注册，它激活就失败 → web boot 整个起不来：
  //
  //   web boot: 1 entry did not activate
  //   @deepseek-ai/dsh-client-ui-directory-picker-native: failed
  //
  // **教训**：`replaceRisk: shadows-shipped-ui` 的单占位洞不是空位，是有主的。
  // 占用者之间会冲突，而且炸的是**别人的激活**，崩溃日志里报的还是别人的名字
  // （不是我们的）—— 只看报错根本想不到是自己干的。
  // 现在走两个**加法式**槽位：
  //   `sidebar.panellist` —— 列表型（多一行导航，id 自己起）
  //   `main`              —— keyed，keyDomain 开放（用一个新 key 就是多一格面板）
  assert.ok(
    client.includes("inject('sidebar.panellist'"),
    '入口应当走加法槽位 sidebar.panellist',
  )
  assert.ok(client.includes("inject('main'"), '面板应当注册到 main 槽位')
  assert.ok(client.includes("inject('shell.overlay'"), '弹窗要挂在 shell.overlay（全窗口浮层）上')
  assert.ok(client.includes("var PANEL_ID = 'multi-remote'"), '两半要共用同一个面板 id')

  // **本地操作不许混进远程开发**：那是 DSH 自己「添加工作区」的活。
  assert.ok(!clientCode.includes('/multi-remote/pick-directory'), '不许再调本机选文件夹路由')
  assert.ok(!clientCode.includes('openFolder'), '不许再出现「打开本机文件夹」这个动作')

  // 剥掉注释后的代码里，绝不能再出现对那个洞的任何注册
  assert.ok(!clientCode.includes('sidebar.workspaces.directoryFlow'), '代码里不许再碰那个洞')
  // 负对照：再占一次 → 用户的 DSH 又打不开（已经发生过一次了）
})

test('客户端：注册必须**同步**完成，不能写在异步回调里', () => {
  // 实测踩坑：注册写在 `fetch(...).then(...)` 里 —— 异步回调**不在插件的
  // 生效作用域内**，注册静默失效。症状极具误导性：没有报错，界面表现
  // 只是「还是官方行为」，插槽占用者查出来仍然只有官方的。
  const injectIndex = clientCode.indexOf("inject('sidebar.panellist'")
  assert.ok(injectIndex > 0, '应当注入 sidebar.panellist')

  const applyIndex = clientCode.lastIndexOf('function apply(ctx', injectIndex)
  assert.ok(applyIndex > 0 && applyIndex < injectIndex, '注册必须在 apply 体内')

  const guardIndex = clientCode.lastIndexOf("if (slots && typeof slots.inject === 'function')", injectIndex)
  assert.ok(guardIndex > applyIndex, '应当找得到 slots 守卫')
  const region = clientCode.slice(guardIndex, injectIndex)
  for (const boundary of ['.then(', 'setTimeout(', 'await ']) {
    assert.ok(!region.includes(boundary), `注册块里出现 ${boundary} —— 异步注册会静默失效（实测踩过）`)
  }

  // 注册**无条件**进行：插件里**没有**「显示 / 隐藏入口」的开关。
  // 插件的开与关由 DSH 自己管（插件管理器会写 `disabled: true`，整行不加载）——
  // 自造第二个开关既多余，又半残（客户端在浏览器里，改配置要刷新页面才生效）。
  assert.ok(!client.includes('workspaceFlow'), '不该再有自造的入口开关')
  assert.ok(!/if \(enabled\)/.test(client), '注册不该被任何开关包住')
  assert.ok(client.includes("report('inject-start'"), '无条件注册，直接上报')
})

test('客户端：每一步都要上报（浏览器里出问题我们看不到控制台）', () => {
  assert.ok(client.includes('function report('), '要有 report')
  assert.ok(client.includes("report('inject-panellist'"), '侧边栏入口的注册结果要上报')
  assert.ok(client.includes("report('inject-main-panel'"), '面板触发器的注册结果要上报')
  assert.ok(client.includes("report('inject-overlay'"), '弹窗宿主的注册结果要上报')
  assert.ok(client.includes("report('dialog-open'"), '弹窗真的被打开要上报')
  assert.ok(client.includes("report('workspace-created'"), '建工作区的结果要上报')
  assert.ok(client.includes('client-report'), '要打到宿主的上报路由')
  // 负对照：不上报 → 「点了没反应」只能靠猜（实测为此白查一轮）
})

test('客户端：面板渲染失败只影响自己（显示一句错误，不炸中央区域）', () => {
  assert.ok(client.includes('class PanelBoundary extends React.Component'), '面板要有渲染错误边界')
  assert.ok(client.includes("report('panel-render-failed'"), '渲染失败要上报')
  assert.ok(client.includes('renderFailed'), '失败要显示出来，不静默消失')
  // 负对照：面板抛错外溢 → React 把整棵子树卸载，症状是「点一下整块消失」
})

test('客户端：createElement 引用的每个组件都必须有定义（渲染期才炸的坑）', () => {
  // ⚠️ 实测事故（2026-10-07）：引用了**没定义**的 SafeDialog ——
  // `createElement(undefined)` 在「渲染期」才炸，React 的处理是**把整棵子树卸载**：
  // 症状是「按钮点一下就消失，毫无反应」。外层 try/catch 抓不到它 ——
  // 那是渲染期的错，不是创建元素时的错。这条测试把它拦在静态阶段。
  const names = [...new Set(
    [...clientCode.matchAll(/React\.createElement\(\s*([A-Z][A-Za-z0-9]*)\b/g)].map((m) => m[1]),
  )]
  assert.ok(names.length >= 5, `应当引用多个自定义组件，实际：${names.join(', ')}`)
  for (const name of names) {
    assert.ok(
      clientCode.includes(`function ${name}(`) || clientCode.includes(`class ${name}`),
      `组件 ${name} 被使用但没有定义 —— 渲染期才会炸，症状是「点了就没」`,
    )
  }
  // 负对照：重命名组件漏改引用 → 上线后点了就没，还没任何报错
})

/**
 * 从 `marker` 后面的 `{` 开始，按**花括号配对**取出整段（跳过字符串里的括号）。
 *
 * 不用「找下一个 `en: {`」这种字符串搜索：那会在别处撞到同样的字符序列，
 * 取出一段混着代码的垃圾 —— 第一版就是这么错的，断言直接报了 `body` 这个
 * 根本不在字典里的 key。
 */
function extractBracedBlock(source, marker) {
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `找不到 ${marker}`)
  const open = source.indexOf('{', start)
  assert.ok(open >= 0, `${marker} 后面没有 {`)
  let depth = 0
  let quote = null
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (quote !== null) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  assert.fail(`${marker} 的花括号没有闭合`)
}

test('客户端：中英文案成对（宿主注册时缺一份会抛错）', () => {
  const zhBlock = extractBracedBlock(client, 'zh: {')
  const enBlock = extractBracedBlock(client, 'en: {')
  assert.ok(zhBlock.length > 100 && enBlock.length > 100, '两段字典都要在')

  const keys = (block) => [...block.matchAll(/^\s+([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]).sort()
  const zh = keys(zhBlock)
  const en = keys(enBlock)
  assert.ok(zh.length >= 25, `中文文案应当有足够条目，实际 ${zh.length}`)
  assert.deepEqual(en, zh, '中英 key 必须一一对应')
  // 负对照：只加中文忘了英文 → locale.register 直接抛错，整个设置页空白
})

test('客户端：失败隔离 —— 注册全部包在 try/catch 里', () => {
  assert.ok(client.includes('client 半边注册失败（不影响宿主）'), 'apply 要有最外层 try/catch')
  assert.ok(client.includes('文案注册失败，退回内置文案'), 'locale 拿不到要退回内置文案')
  // 负对照：客户端半边抛错外溢 → 宿主 UI 受影响
})

test('客户端：远程开发走「先连机器、再选文件夹」两步，不要求盲填项目根', () => {
  // 用户提的流程（也是 VS Code / ZCode 的做法）。为什么重要：
  // 原来的「一次填完」要盲填远程项目根 —— 用户填成 /home/user/新建文件夹
  // （真实位置是 /home/user/桌面/新建文件夹），连接照样成功、之后每条命令都失败。
  assert.ok(clientCode.includes("'/multi-remote/machine-connect'"), '要有「连机器」这条路由')
  assert.ok(clientCode.includes("'/multi-remote/machine-list'"), '要有「列目录」这条路由')
  assert.ok(clientCode.includes("'/multi-remote/machine-open'"), '要有「用这个文件夹建工作区」这条路由')

  // 连机器那一步**不能**带 remoteRoot —— 那正是要消灭的盲填
  const connectFn = clientCode.slice(
    clientCode.indexOf('function connectMachine('),
    clientCode.indexOf('function listDir('),
  )
  assert.ok(connectFn.length > 50, '应当找得到 connectMachine')
  assert.ok(!connectFn.includes('remoteRoot'), '连机器阶段不该出现 remoteRoot')
  assert.match(connectFn, /var body = \{ kind: kind \}/, '只发后端信息（kind 来自左栏选择）')

  // 必须有「浏览」视图：列出远程目录、能进能退、能选
  assert.ok(clientCode.includes("step === 'browse'"), '要有浏览视图')
  assert.ok(clientCode.includes('function listDir('), '要能列目录')
  assert.ok(clientCode.includes('function openProject('), '要能把选中的文件夹变成工作区')
  assert.ok(clientCode.includes('listing.parent'), '要能回上一层')
  // 负对照：保留盲填 → 用户继续踩「路径不存在」的坑
})

test('客户端：目录列表有上限保护（一个目录可能上万个条目）', () => {
  assert.ok(clientCode.includes('dirs.slice(0, 200)'), '要截断显示')
  assert.ok(clientCode.includes('tooManyDirs'), '截断了要说出来')
  // 负对照：一个 5 万条的目录直接把弹窗卡死
})

test('客户端：WSL / Docker 走**自动识别**，不让用户盲填', () => {
  // 用户提的：发行版和容器都是能识别出来的，不该让人手打名字 ——
  // 手打错了连接照样「成功」，但之后每条命令都失败，极难排查。
  assert.ok(clientCode.includes('options.targets'), '要用宿主识别出来的目标列表')
  assert.ok(clientCode.includes('wslInfo.distros'), 'WSL 用识别到的发行版列表')
  assert.ok(clientCode.includes('dockerInfo.containers'), 'Docker 用识别到的容器列表')
  // 识别不到才退回手填兜底 —— 不能因为探测失败就完全没法连
  assert.ok(clientCode.includes('distro-manual'), '要留手填兜底')
  assert.ok(clientCode.includes('container-manual'), '要留手填兜底')
  // SSH 没有「自动识别」这回事（要凭据），所以用**用过的连接**
  assert.ok(clientCode.includes('sshProfiles'), 'SSH 要用保存过的档案')
  assert.ok(clientCode.includes("t('newConnection')"), '要能新建连接')
  // 负对照：让用户盲填发行版名 → 填错照样「成功」，但每条命令都失败
})

test('客户端：弹窗**固定尺寸** + 左侧导航（内容多少都不跳动）', () => {
  assert.ok(clientCode.includes("width: '620px', height: '440px'"), '固定宽高，别随内容变')
  assert.ok(clientCode.includes('function NavRow('), '左栏是导航（带识别结果）')
  assert.ok(clientCode.includes('function OptionRow('), '右侧是**选项**而不是表单')
  // 负对照：弹窗高度跟着内容长 → 操作栏乱跳，用户找不到「连接」
})

test('客户端：「探测失败」与「成功但没有」要分开处理', () => {
  // 用户实测反馈：Docker 守护进程好好的、只是**没有容器**，界面却给了一个
  // 「容器名或 ID」输入框 —— 填了也连不上（那台机器上确实没有这个容器），
  // 只会让人以为「填对了就能连」。反过来，探测**失败**时必须留手填兜底，
  // 否则探测一坏就完全没法连。
  assert.ok(clientCode.includes('function detectionFailed('), '要区分「失败」与「成功但没有」')
  assert.ok(clientCode.includes("t('noContainerHint')"), '没有容器要给空状态 + 引导')
  assert.ok(clientCode.includes("t('noDistroHint')"), '没有发行版同理')

  // 手填兜底只能出现在 detectionFailed 分支里
  for (const [guard, manualKey] of [['detectionFailed(wslInfo)', "key: 'distro-manual'"], ['detectionFailed(dockerInfo)', "key: 'container-manual'"]]) {
    const manualAt = clientCode.indexOf(manualKey)
    assert.ok(manualAt > 0, `应当找得到 ${manualKey}`)
    const guardAt = clientCode.lastIndexOf(guard, manualAt)
    assert.ok(guardAt > 0 && guardAt < manualAt, `${manualKey} 必须在 ${guard} 分支内`)
    // 而且中间不能跨过另一个分支的开始
    const between = clientCode.slice(guardAt, manualAt)
    assert.ok(!between.includes('} else {'), `${manualKey} 不能落在别的分支里`)
  }

  // 左栏只给短提示（数量），别把整句原因塞进去 —— 会被截断成
  // 「守护进程可用，但没有任何...」（用户实测反馈）
  assert.ok(clientCode.includes('function countHint('), '左栏要用短提示')
  // 负对照：无条件给手填框 → 用户填一个不存在的容器名，失败还不知道为什么
})