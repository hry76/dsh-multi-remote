/**
 * `src/client.js` 的契约测试 —— 客户端半边。
 *
 * ## 为什么要测
 *
 * 客户端半边只在**浏览器**里跑，所以最容易腐烂：没人跑它，改了宿主侧也不会碰它。
 * 实测就抓到一个：设置页一直写着「尚未实现任何连接能力」，还指着一个**早就不存在**
 * 的工具名。功能全做完了，界面上却说自己什么都没做 —— 这比没有界面更坏。
 *
 * ## 怎么测
 *
 * 在 Node 里**真的把 bundle 加载一遍**：造一个 `window.__ModuleLoader__` 替身，
 * 一个最小 `require`（只给 react 的 createElement），然后调 `apply(ctx)`。
 * 这样覆盖的是真实加载路径（自注册 + factory + apply），不是「文件里有某个字符串」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CLIENT_SOURCE = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

/**
 * 把 client.js 加载进一个替身环境，返回加载器拿到的模块。
 *
 * @param {object} [options]
 * @param {boolean} [options.withoutLocale] 模拟宿主没有 locale 服务
 * @param {boolean} [options.localeThrows] 模拟 locale 注册抛错
 */
function loadClient(options = {}) {
  const loaded = []
  const registered = []
  const effects = []
  const logs = { info: [], warn: [] }

  const win = {
    __ModuleLoader__: {
      load(spec) {
        loaded.push(spec)
      },
    },
  }

  // 最小 react 替身：只要 createElement 能拼出一棵树就行
  const React = {
    createElement(type, props, ...children) {
      const kids = children.flat().filter((child) => child !== null && child !== undefined)
      // `props.children` 也要给 —— 真 React 就是这个形状，而渲染错误边界
      // （类组件）靠 `this.props.children` 往下传。
      return { type, props: { ...(props ?? {}), children: kids }, children: kids }
    },
    // 客户端代码用了类组件（渲染错误边界）。替身里没有 Component 的话，
    // `class X extends React.Component` 会在 apply 时抛错 → 全部注册被跳过。
    // ⚠️ `this.props` 必须由基类设置 —— 真 React 就是这么做的，
    // 少了它错误边界里的 `this.props.children` 会读 undefined（实测踩到）。
    Component: class Component {
      constructor(props) {
        this.props = props ?? {}
      }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, function () {}]
    },
    /**
     * **立刻执行** effect —— 不是真 React 的行为，但这是让「渲染一帧」有意义的关键：
     * 侧边栏那一行的 effect 里会打开弹窗，不执行的话我们永远渲染不到弹窗本体。
     * 替身环境里没有 `fetch`，所以执行失败一律吞掉（真实客户端也是这么隔离的）。
     */
    useEffect(fn) {
      try {
        if (typeof fn === 'function') fn()
      } catch {
        /* 替身环境没有 fetch / AbortController，忽略 */
      }
      return undefined
    },
  }

  const requireFn = (name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require：${name}`)
  }

  // 在隔离的函数作用域里跑源码，把 window / require 注进去。
  // 注意：宿主加载器把 `factory()` 的返回值**当成 module.exports 本身**，
  // 所以拿到的是 `{ apply, inject }`，不是 `{ exports: { apply } }`。
  const load = new Function('window', 'require', 'console', `${CLIENT_SOURCE}; return undefined`)
  load(win, requireFn, { info: (...a) => logs.info.push(a), warn: (...a) => logs.warn.push(a) })

  assert.equal(loaded.length, 1, '应当恰好自注册一次')
  const exports = loaded[0].factory(requireFn)
  assert.equal(typeof exports, 'object', 'factory 应当返回 exports 对象')

  const localeDicts = []
  const ctx = {
    slots: {
      inject(name, register) {
        registered.push({ name, register })
      },
      register(spec, component) {
        return { spec, component }
      },
    },
    effect(fn, label) {
      effects.push({ label, fn })
      return () => {}
    },
  }

  if (options.withoutLocale !== true) {
    ctx.locale = {
      register(ns, dicts) {
        if (options.localeThrows === true) throw new Error('命名空间已被占用')
        localeDicts.push({ ns, dicts })
        return () => {}
      },
      bind(ns) {
        // 模拟宿主：查不到就回显 key
        return (key) => key
      },
    }
  }

  return { exports, ctx, loaded, registered, effects, logs, localeDicts, React }
}

// ── 加载形态 ────────────────────────────────────────────────────────────────

test('客户端：通过 __ModuleLoader__ 自注册，并导出 apply / inject', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.apply, 'function', '必须导出 apply')
  assert.deepEqual(exports.inject, ['slots', 'locale'], '必须声明需要的客户端服务')
  // 负对照：写成 ESM 或直接导出组件 → 宿主根本不会加载这一半
})

test('客户端：apply 注册设置页小节，且 label 是个函数（会随语言切换）', () => {
  const { exports, ctx, registered } = loadClient()
  exports.apply(ctx)

  const settings = registered.filter((entry) => entry.name === 'settings.section')
  assert.equal(settings.length, 1, '应当注册一个小节')
  assert.equal(settings[0].name, 'settings.section')

  const result = settings[0].register()
  assert.equal(result.spec.id, 'multi-remote')
  assert.equal(typeof result.spec.label, 'function', 'label 必须是函数，否则切语言不会跟着变')
  assert.equal(result.spec.label(), '远程开发')
  assert.equal(typeof result.component, 'function', '应当给出一个组件')
  // 负对照：label 写成固定字符串 → 切换语言后设置页还是旧语言
})

// ── 「远程开发」入口（**这些测试本该早点写**）────────────────────────────

test('客户端：apply **同步**注册侧边栏入口 + 面板（两半必须一起）', () => {
  // ⚠️ 补写的教训：第一版把注册写在 `fetch(...).then(...)` 里 —— 异步回调
  // 不在插件的生效作用域内，注册**静默失效**。这个框架同步调 `apply`
  // 再立刻检查注册，只要写了这条，一眼就能看出「注册根本没发生」。
  const { exports, ctx, registered } = loadClient()
  exports.apply(ctx)

  const entries = registered.filter((entry) => entry.name === 'sidebar.panellist')
  assert.equal(entries.length, 1, 'apply 返回时就必须已注册 —— 不能等异步回调')

  const result = entries[0].register()
  assert.equal(result.spec.id, 'multi-remote', 'id 必须与 main 的 key 一致')
  assert.equal(typeof result.spec.label, 'function', 'label 是函数，会随语言切换')
  assert.equal(result.spec.label(), '远程开发')
  assert.equal(typeof result.component, 'function', '要给出图标组件')

  // 图标组件要能用宿主传的两个 prop 渲染出来（{ size, active }）——
  // 宿主负责画按钮和标签，我们只交图标。
  const icon = result.component({ size: 18, active: true })
  assert.equal(icon.type, 'svg', '图标必须是 svg（用 currentColor 跟着主题走）')
  assert.equal(icon.props.width, 18, '尺寸要听宿主的')
  assert.equal(icon.props.stroke, 'currentColor', '颜色必须交给宿主，不能写死')

  // 第二半：`main` 里那一格**触发器**。少了它，侧边栏那一行点下去是一片空白
  // （宿主靠同一个 id 把「哪一行」和「哪一格」配起来）。
  const panels = registered.filter((entry) => entry.name === 'main')
  assert.equal(panels.length, 1, '必须同时注册 main 面板那一格')
  const panel = panels[0].register()
  assert.equal(panel.spec.key, 'multi-remote', 'key 必须与侧边栏 id 一致')
  assert.equal(typeof panel.component, 'function', '要给出触发器组件')

  // 第三半：真正的弹窗，挂在**全窗口浮层**上 —— 否则弹窗会被关在中央区域里，
  // 盖不住侧边栏，看起来就不像个弹窗。
  const overlays = registered.filter((entry) => entry.name === 'shell.overlay')
  assert.equal(overlays.length, 1, '弹窗要挂在 shell.overlay 上')
  const overlay = overlays[0].register()
  assert.equal(overlay.spec.id, 'multi-remote-dialog')
  assert.equal(typeof overlay.component, 'function', '要给出弹窗组件')
})

test('客户端：workspaceFlow=false 时**完全不注册**入口', () => {
  const { exports, ctx, registered } = loadClient()
  exports.apply(ctx, { workspaceFlow: false })

  for (const name of ['sidebar.panellist', 'main', 'shell.overlay']) {
    assert.equal(
      registered.filter((entry) => entry.name === name).length,
      0,
      `关掉之后不许注册 ${name}`,
    )
  }
  // 设置页仍然要在（关的只是入口）
  assert.equal(registered.filter((entry) => entry.name === 'settings.section').length, 1)
  // 负对照：忽略开关 → 用户关不掉，只能卸载整个插件
})

test('客户端：绝不注册 `+` 按钮的目录流程（会让官方插件激活失败）', () => {
  // 实测：占了那个洞 → @deepseek-ai/dsh-client-ui-directory-picker-native
  // 激活失败 → web boot 起不来 → 用户的 DSH 打不开
  const { exports, ctx, registered } = loadClient()
  exports.apply(ctx)

  assert.equal(
    registered.filter((entry) => entry.name === 'sidebar.workspaces.directoryFlow').length,
    0,
    '那个洞有官方归属，占它 = 搞挂用户的 DSH',
  )
})

test('客户端：入口注册失败不影响设置页小节', () => {
  const { exports, ctx, registered, logs } = loadClient()
  // 让 inject 对入口抛错，模拟宿主版本不匹配
  const original = ctx.slots.inject
  ctx.slots.inject = function (name, callback) {
    if (name === 'sidebar.panellist') throw new Error('未知槽位')
    return original.call(this, name, callback)
  }
  exports.apply(ctx)

  assert.equal(registered.filter((entry) => entry.name === 'settings.section').length, 1, '设置页不该受影响')
  assert.ok(
    logs.warn.some((args) => String(args[0]).includes('注册侧边栏入口失败')),
    '失败要留日志 —— 否则又是「静默失效」',
  )
  // 负对照：入口抛错把整个 apply 带崩 → 设置页也没了
})

// ── i18n ────────────────────────────────────────────────────────────────────

test('客户端：注册中英双份字典（宿主强制双语平衡）', () => {
  const { exports, ctx, localeDicts } = loadClient()
  exports.apply(ctx)

  assert.equal(localeDicts.length, 1, '应当注册一份文案')
  const { ns, dicts } = localeDicts[0]
  assert.equal(ns, 'multi-remote')
  assert.deepEqual(Object.keys(dicts).sort(), ['en', 'zh'], '必须同时给 en 与 zh')
  assert.deepEqual(
    Object.keys(dicts.zh).sort(),
    Object.keys(dicts.en).sort(),
    '两份字典的 key 必须一一对应',
  )
  assert.ok(Object.keys(dicts.zh).length >= 5, '文案应当覆盖标题/说明/连接/流程/自检')
  // 负对照：只注册一份 → 宿主注册时抛错，设置页整个挂掉
})

test('客户端：拿不到 locale 服务时退回内置文案，不空白', () => {
  const { exports, ctx, registered } = loadClient({ withoutLocale: true })
  exports.apply(ctx)

  const result = registered[0].register()
  assert.equal(result.spec.label(), '远程开发', '没有 locale 也该有中文文案')
  // 负对照：缺服务就让设置页空白 → 用户以为插件没装上
})

test('客户端：locale 注册抛错时也不影响设置页', () => {
  const { exports, ctx, registered, logs } = loadClient({ localeThrows: true })
  exports.apply(ctx)

  const settings = registered.filter((entry) => entry.name === 'settings.section')
  assert.equal(settings.length, 1, '文案失败不该拦住小节注册')
  const result = settings[0].register()
  assert.equal(result.spec.label(), '远程开发')
  assert.ok(logs.warn.length > 0, '失败要留一条 warn，不静默')
  // 负对照：文案注册失败直接抛出 → 整个设置页消失，用户完全不知道发生了什么
})

// ── 渲染 ────────────────────────────────────────────────────────────────────

test('客户端：小节渲染出真实状态说明，不含过时占位文案', () => {
  const { exports, ctx, registered } = loadClient()
  exports.apply(ctx)

  const result = registered[0].register()
  const tree = result.component()

  // 把树摊平成文本
  const textOf = (node) => {
    if (typeof node === 'string') return node
    if (node === null || node === undefined) return ''
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    return (node.children ?? []).map(textOf).join(' ')
  }
  const text = textOf(tree)

  assert.match(text, /dsh-multi-remote/)
  assert.match(text, /remote_connect/, '应当告诉用户怎么连接')
  assert.match(text, /ssh \/ wsl \/ docker/i, '应当说明支持三种后端')
  assert.match(text, /锚点|工作区/, '应当提醒「先开工作区再建会话」这个顺序约束')

  // 过时内容绝不能出现
  for (const stale of ['尚未实现', 'multi_remote_hello', 'TODO', '占位']) {
    assert.ok(!text.includes(stale), `界面里不该出现：${stale}`)
  }
  // 负对照：界面上说「尚未实现任何连接能力」→ 用户以为自己装错了版本
})

test('客户端：加载过程不抛错（失败必须隔离在客户端半边内）', () => {
  // 客户端半边出问题不允许影响宿主 UI —— 所以 apply 里全部包 try/catch
  const { exports, ctx } = loadClient()
  // 把 slots 弄坏，模拟宿主 UI 结构变化
  ctx.slots = { inject() { throw new Error('宿主 slot 结构变了') } }
  assert.doesNotThrow(() => exports.apply(ctx))
  // 负对照：不 try/catch → 一个 slot 变化就让整个设置页白屏
})

// ── 真的渲染一帧 ────────────────────────────────────────────────────────────
//
// 为什么必须有这一节：有一类错误**只在渲染期**才炸，静态检查（「文件里有没有
// 某个字符串」）永远抓不到。实测踩过两次：
//   1. 2026-10-07 `createElement(undefined)`（重命名漏改）→ React 把整棵子树卸载，
//      症状是「按钮点一下就消失」；
//   2. 2026-10-09 弹窗第一帧读 `null.systemDistros` → 整个弹窗变成一块错误面板。
// 两次都是用户先看到的。所以这里用一个极简渲染器把第一帧真的走一遍。

/**
 * 极简渲染器：走一遍元素树，**真的调用**函数组件与类组件。
 *
 * 不追求像 React —— 只追求「把渲染期会执行的代码都执行到」。
 * 副作用（useEffect）由替身决定：立刻执行，失败吞掉。
 */
function renderTree(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return null
  if (typeof element === 'string' || typeof element === 'number') return element
  if (Array.isArray(element)) return element.map(renderTree)

  const { type, props } = element
  if (typeof type === 'function') {
    // 类组件（渲染错误边界）：new 出来调 render()
    if (type.prototype !== undefined && typeof type.prototype.render === 'function') {
      return renderTree(new type(props).render())
    }
    return renderTree(type(props))
  }
  return { type, children: renderTree(element.children) }
}

test('客户端：弹窗**第一帧**就能渲染（可选项还没回来时也不许炸）', () => {
  // ⚠️ 真机事故（2026-10-09）：弹窗一打开、宿主还没返回可选项时 `wslInfo` 是 null，
  // 而 WSL 分支直接读了 `wslInfo.systemDistros` → 渲染期抛错 →
  // 用户看到的是「远程开发打不开，显示出错了」（审计里是 panel-render-failed）。
  const { exports, ctx, registered } = loadClient()
  exports.apply(ctx)

  const overlay = registered.find((entry) => entry.name === 'shell.overlay').register()
  const main = registered.find((entry) => entry.name === 'main').register()

  // 弹窗默认关着：第一帧返回 null，不炸
  assert.doesNotThrow(() => renderTree(overlay.component()), '关着的弹窗不该炸')

  // 走**真实路径**打开它：侧边栏那一行的触发器（它的 effect 会开弹窗），
  // 然后再渲染弹窗那一帧 —— 此刻 options 还是 null，正是出事的那个瞬间。
  assert.doesNotThrow(() => renderTree(main.component()), '触发器不该炸')
  const opened = renderTree(overlay.component())
  assert.ok(opened !== null, '打开之后应当渲染出内容（不是 null）')

  // 而且不许渲染成错误面板 —— 那是 PanelBoundary 兜底的样子
  const text = (() => {
    const flatten = (node) => {
      if (node === null || node === undefined) return ''
      if (typeof node === 'string') return node
      if (Array.isArray(node)) return node.map(flatten).join(' ')
      return flatten(node.children)
    }
    return flatten(opened)
  })()
  assert.ok(!text.includes('其它功能不受影响'), `不该落到错误面板，实际文本：${text.slice(0, 200)}`)
  // 负对照：读 null 的属性 → 整个弹窗变成一块错误面板（真机就是这么坏的）
})
