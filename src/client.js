/**
 * dsh-multi-remote — 客户端半边
 *
 * 形态与宿主约定一致：浏览器 bundle 通过 `window.__ModuleLoader__.load({id, factory})`
 * 自注册，factory 里拿到的是 CommonJS 风格的 require（宿主按 package.json 的
 * `dsh.client.inject` 注入这些包）。导出 `apply(ctx, config)` 与 `inject`。
 *
 * ## 这一半做三件事
 *
 * 1. **设置页小节** —— 告诉用户插件在哪、怎么用。
 * 2. **侧边栏导航行**（`sidebar.panellist`，id `multi-remote`）——
 *    和官方的「插件」并列的一行。宿主负责画那个按钮、管选中态、渲染标签，
 *    我们只交一个图标组件（宿主传 `{ size, active }` 进来）。
 * 3. **「远程开发」弹窗**（`shell.overlay`）—— 点那一行之后弹出的模态：
 *    连一台机器 → 看着远程真实目录选项目 → 建成工作区。
 *
 * ## 三块怎么连起来（宿主把它们渲染成互不相干的子树）
 *
 * ```
 *   sidebar.panellist 那一行
 *        ↓ 宿主 selectPanel('multi-remote')
 *   main[key=multi-remote]  ← RemoteTrigger：只做一件事
 *        ↓ setDialogOpen(true) + 立刻切回会话
 *   shell.overlay           ← RemoteDialog：真正的弹窗（root 作用域，盖住整个框架）
 * ```
 *
 * `main` 那一格是**必须**的：宿主靠同一个 id 把「侧边栏哪一行」和「主区域哪一格」
 * 配起来，少了它那一行点下去就是空白。但它不画界面 —— 只当跳板，
 * 把界面交给 `shell.overlay` 上的真弹窗（否则弹窗会被关在中央区域里，盖不住侧边栏）。
 * 两棵子树之间用一个模块级订阅表通信（见 `setDialogOpen`），不引状态库。
 *
 * ## 2026-10-09 两次改版的教训
 *
 * 1. **别自造 UI**。第一版是侧边栏底部一个小按钮 + 自己画的浮层弹窗：
 *    位置、留白、选中态、配色全得自己管，一眼就不像 DSH。
 *    现在图标由宿主画、选中态由宿主管、弹窗用真 token。
 * 2. **当时用的 `--dsh-*` CSS 变量全是编的**（真实 token 是 `--dsw-alias-*`），
 *    所以每个样式都在静默地吃硬编码兜底色 —— 换主题就露馅。**变量名不要猜。**
 * 3. **本地的操作不要混进远程开发里**：「打开本机文件夹」是 DSH 自己
 *    「添加工作区」的活，放进这个弹窗只会让人以为它属于远程流程。
 *
 * ## ⚠️ 为什么**不**占 `+` 按钮的流程 —— 实测会把 DSH 搞到打不开
 *
 * 第一版占的是 `+` 按钮的目录流程洞（`sidebar.workspaces.directoryFlow`），
 * 位置和交互都更贴近用户的要求 —— 但**真机立刻翻车**：
 *
 * ```
 * web boot: 1 entry did not activate
 * @deepseek-ai/dsh-client-ui-directory-picker-native: failed
 * ```
 *
 * 那个洞**已经有官方归属** —— 桌面端的「打开文件夹」由官方插件
 * `@deepseek-ai/dsh-client-ui-directory-picker-native` 提供。
 * 我们一注册，它激活就失败，**整个 web boot 起不来**，用户的 DSH 打不开。
 * 教训：**single 型 + `replaceRisk: shadows-shipped-ui` 的洞不是空位，是有主的**，
 * 占它之前先想清楚「原占用者激活失败会发生什么」。
 *
 * 所以现在用 **`sidebar.footer.action`**（列表型加法槽位，`replaceRisk: none`）：
 * 多一个占用者就是多一个按钮，谁也不影响谁。
 *
 * ## 界面怎么跟宿主说话
 *
 * 走 HTTP 路由（`fetch('/multi-remote/...')`）—— 实测第三方客户端插件就是这么做的。
 * 客户端内置的 `host.call` 是包私有 RPC，但宿主侧怎么注册它没有公开约定，
 * 不去猜一个不知道契约的接缝。
 *
 * ## 自诊断
 *
 * 客户端在浏览器里跑，出问题时**我们看不到它的控制台**。
 * 所以每一步（apply / 注册 / 弹窗打开 / 建工作区）都 POST 回宿主的
 * `/multi-remote/client-report`，写进审计日志 —— 出问题不用猜。
 *
 * ## 失败隔离
 *
 * 所有注册都包在 try/catch 里 —— 客户端半边出问题**不允许**影响宿主 UI。
 */
window.__ModuleLoader__.load({
  id: '@jk-uzi/dsh-multi-remote',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** 与宿主 `src/http/ui-routes.js` 里的路由常量保持一致。 */
    var ROUTE_OPTIONS = '/multi-remote/connect-options'
    var ROUTE_CONNECT = '/multi-remote/connect'
    var ROUTE_REPORT = '/multi-remote/client-report'
    // 「先连机器、再选文件夹」流程
    var ROUTE_MACHINE_CONNECT = '/multi-remote/machine-connect'
    var ROUTE_MACHINE_LIST = '/multi-remote/machine-list'
    var ROUTE_MACHINE_OPEN = '/multi-remote/machine-open'
    var ROUTE_OPEN_WORKSPACE = '/multi-remote/open-workspace'
    /** 插件设置：读当前值 / 改配置（改配置走宿主的 configEditor）。 */
    var ROUTE_SETTINGS = '/multi-remote/settings'

    /**
     * 面板 id。
     *
     * 侧边栏那一行（`sidebar.panellist` 的 `id`）与中央面板（`main` 的 `key`）
     * **必须是同一个值** —— 宿主就是靠它把「点哪一行」和「显示哪一页」配起来的。
     */
    var PANEL_ID = 'multi-remote'

    /**
     * 弹窗开关的极小状态机。
     *
     * 为什么需要它：**侧边栏那一行**（`main` 面板里的触发器）与**弹窗本体**
     * （`shell.overlay`）是宿主渲染的两棵互不相干的子树，没法互相传 props。
     * 所以用一张模块级的订阅表把两者连起来 —— 别为这点事引入状态库。
     */
    var dialogState = { open: false }
    var dialogSubscribers = []

    function setDialogOpen(next) {
      dialogState.open = next
      for (var i = 0; i < dialogSubscribers.length; i += 1) {
        try {
          dialogSubscribers[i](next)
        } catch (error) {
          // 一个订阅者坏了不影响别人
          console.warn('[dsh-multi-remote] 弹窗订阅者抛错:', error)
        }
      }
    }

    /**
     * 把「走到哪一步」报回宿主。
     *
     * **为什么需要**：客户端跑在浏览器里，出问题时我们看不到它的控制台。
     * 实测就吃过一次亏 —— 注册写在 `fetch(...).then(...)` 里**静默失效**，
     * 而界面表现只是「还是官方行为」，完全看不出原因，只能靠猜。
     * 现在每一步都报回来，从审计日志就能读。
     *
     * 上报**绝不能影响功能**：全包在 try/catch 里，失败就放弃。
     */
    function report(step, ok, detail) {
      try {
        fetch(ROUTE_REPORT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            step: String(step).slice(0, 80),
            ok: ok === true,
            detail: detail === undefined || detail === null ? null : String(detail).slice(0, 280),
          }),
          keepalive: true,
        }).catch(function () { /* 诊断失败不影响功能 */ })
      } catch (error) {
        /* 同上 */
      }
    }

    /** 文案表。宿主强制中英双份齐全，缺一份注册就会抛错。 */
    var DICTIONARIES = {
      zh: {
        sectionLabel: '远程开发',
        title: 'dsh-multi-remote',
        summary: 'SSH / WSL / Docker 三合一远程开发：文件读写与命令执行落在目标环境，模型与决策留在本地。',
        connect: '连接：点侧边栏的「远程开发」，或让 agent 调用 remote_connect。',
        flow: '连上之后，把锚点目录作为工作区打开、再新建会话 —— 预设只能在第一轮之前选定。',
        selfcheck: '自检：GET /multi-remote/selfcheck（会报告三种后端各自的可用性）',

        loading: '正在读取当前设置…',
        notEditable: '这个 profile 没有 configEditor 服务，界面改不了配置 —— 可以手工改 profile 的 cordis.patch.yml 里 multi-remote 那一行的 config。',
        entryLabel: '在侧边栏显示「远程开发」',
        entryHint: '关掉之后那一行不再出现（remote_* 工具与这一页仍在）。',
        deepenLabel: '连上之后在后台补拉镜像',
        deepenHint: '把「文本类 + 上限内」的文件补到本地镜像，界面里点开就有内容；不阻塞连接。',
        maxFileLabel: '单个文件上限（MiB）',
        maxTotalLabel: '总量上限（MiB）',
        auditLabel: '审计日志条数上限',
        reloadWarning: '保存后会重载插件 —— 已连接的远程工作区会断开，重新连一次即可。',
        save: '保存',
        saving: '正在保存…',
        saved: '已保存。',
        saveFailed: '保存失败：',
        saveFailedUnknown: '未知错误',

        remoteConnect: '远程开发',
        remoteConnectHint: '连接到 SSH / WSL / Docker 里的项目',
        dialogIntro: '连上 SSH / WSL / Docker 机器，看着远程真实目录选一个项目文件夹 —— 不用自己拼路径。',
        close: '关闭',
        kindWsl: 'WSL',
        kindSsh: 'SSH',
        kindDocker: 'Docker',
        fieldDistro: '发行版名',
        fieldContainer: '容器名或 ID',
        fieldHost: '主机',
        fieldPort: '端口（默认 22）',
        fieldUsername: '登录账号',
        fieldKeyPath: '私钥文件路径',
        fieldPassword: '密码（可选）',
        savedProfiles: '用过的连接',
        connectMachine: '连接',
        connecting: '正在连接…',
        cancel: '取消',
        back: '返回',
        changeMachine: '换一台机器',
        up: '上一层',
        noSubdirs: '（这个文件夹里没有子文件夹）',
        tooManyDirs: '子文件夹太多，只显示前 200 个',
        filesHere: '个文件（这里只列文件夹）',
        openHere: '就用这个文件夹',
        machineConnected: '已连接的机器',
        pickDistro: '选择发行版',
        pickContainer: '选择容器',
        newConnection: '新建连接',
        newConnectionHint: '手动填写主机与账号',
        backToList: '← 返回用过的连接',
        stoppedReadOnly: '这个容器已停止：只能读文件内容，命令执行不可用',
        distroCount: '个发行版',
        containerCount: '个容器',
        savedCount: '个用过的',
        sshNoSaved: '还没用过',
        detecting: '正在识别…',
        refreshTargets: '重新识别（启动 Docker Desktop 之后点这个）',
        noneDistro: '没有发行版',
        noneContainer: '没有容器',
        detectFailed: '识别失败',
        noDistroHint: '这台机器上没有可用的 WSL 发行版。装一个（wsl --install）之后，点右上角 ↻ 重新识别。',
        noContainerHint: '这台机器上还没有容器。先在终端 docker run / docker start 一个，再点右上角 ↻。',
        filterLabel: '筛选',
        filterPlaceholder: '输入关键字…',
        filterNoMatch: '没有匹配项',
        optionCount: '项',
        connectFailed: '连接失败：',
        listFailed: '读取目录失败：',
        openWorkspaceFailed: '工作区没能建好：',
        renderFailed: '远程开发出错了（其它功能不受影响）',
      },
      en: {
        sectionLabel: 'Remote Development',
        title: 'dsh-multi-remote',
        summary: 'SSH / WSL / Docker remote development: file and command execution happen on the target, the model stays local.',
        connect: 'Connect: use "Remote development" in the sidebar, or have the agent call remote_connect.',
        flow: 'After connecting, open the anchor directory as a workspace, then create a new session — the preset can only be chosen before the first turn.',
        selfcheck: 'Self-check: GET /multi-remote/selfcheck (reports per-backend availability)',

        loading: 'Loading current settings…',
        notEditable: 'This profile has no configEditor service, so settings cannot be changed here — edit the config of the multi-remote row in the profile cordis.patch.yml instead.',
        entryLabel: 'Show "Remote development" in the sidebar',
        entryHint: 'Turn it off to hide that row (the remote_* tools and this page stay).',
        deepenLabel: 'Deepen the mirror in the background after connecting',
        deepenHint: 'Copies text files within the limits into the local mirror so they open instantly; does not block the connection.',
        maxFileLabel: 'Per-file limit (MiB)',
        maxTotalLabel: 'Total limit (MiB)',
        auditLabel: 'Audit log capacity',
        reloadWarning: 'Saving reloads the plugin — connected remote workspaces disconnect; just reconnect.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved.',
        saveFailed: 'Save failed: ',
        saveFailedUnknown: 'unknown error',

        remoteConnect: 'Remote development',
        remoteConnectHint: 'Connect to a project over SSH / WSL / Docker',
        dialogIntro: 'Connect to an SSH / WSL / Docker machine and pick a project folder from its real directory tree — no path guessing.',
        close: 'Close',
        kindWsl: 'WSL',
        kindSsh: 'SSH',
        kindDocker: 'Docker',
        fieldDistro: 'Distribution',
        fieldContainer: 'Container name or id',
        fieldHost: 'Host',
        fieldPort: 'Port (default 22)',
        fieldUsername: 'Username',
        fieldKeyPath: 'Private key path',
        fieldPassword: 'Password (optional)',
        savedProfiles: 'Previously used',
        connectMachine: 'Connect',
        connecting: 'Connecting…',
        cancel: 'Cancel',
        back: 'Back',
        changeMachine: 'Use another machine',
        connectFailed: 'Connection failed: ',
        machineConnected: 'Connected machine',
        up: 'Parent folder',
        noSubdirs: '(no subfolders here)',
        tooManyDirs: 'Too many subfolders — showing the first 200',
        filesHere: 'file(s) here (folders only are listed)',
        openHere: 'Use this folder',
        pickDistro: 'Pick a distribution',
        pickContainer: 'Pick a container',
        newConnection: 'New connection',
        newConnectionHint: 'Enter host and account manually',
        backToList: '← Back to previously used',
        stoppedReadOnly: 'This container is stopped: file contents work, running commands does not',
        distroCount: 'distribution(s)',
        containerCount: 'container(s)',
        savedCount: 'used',
        sshNoSaved: 'none yet',
        detecting: 'Detecting…',
        refreshTargets: 'Re-detect (click after starting Docker Desktop)',
        noneDistro: 'no distributions',
        noneContainer: 'no containers',
        detectFailed: 'detection failed',
        noDistroHint: 'No usable WSL distribution on this machine. Install one (wsl --install), then click ↻ above.',
        noContainerHint: 'No containers on this machine yet. Start one (docker run / docker start), then click ↻ above.',
        filterLabel: 'Filter',
        filterPlaceholder: 'Type to filter…',
        filterNoMatch: 'No matches',
        optionCount: 'item(s)',
        listFailed: 'Could not list the directory: ',
        renderFailed: 'Remote development failed (everything else is unaffected)',
        openWorkspaceFailed: 'Could not create the workspace: ',
      },
    }

    /**
     * 取翻译函数。
     *
     * 拿不到 locale 服务时退回内置文案 —— 设置页不该因为缺一个服务而空白。
     * 这也是「失败隔离」的一部分：客户端半边的问题不能外溢到宿主 UI。
     */
    function translator(ctx) {
      try {
        var locale = ctx.locale
        if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          var dispose = locale.register('multi-remote', DICTIONARIES)
          if (typeof ctx.effect === 'function') ctx.effect(function () { return dispose }, 'multi-remote: 文案')
          var t = locale.bind('multi-remote')
          return function (key) {
            var value = t(key)
            // `bind` 查不到时会回显 key 本身；这时退回内置文案更友好
            return value === key ? DICTIONARIES.zh[key] : value
          }
        }
      } catch (error) {
        console.warn('[dsh-multi-remote] 文案注册失败，退回内置文案:', error)
      }
      return function (key) { return DICTIONARIES.zh[key] }
    }

    /** 带超时的 JSON 请求。失败一律抛出**能看懂**的错误，界面直接显示。 */
    function postJson(url, body, timeoutMs) {
      var controller = typeof AbortController === 'function' ? new AbortController() : undefined
      var timer = setTimeout(function () { if (controller) controller.abort() }, timeoutMs || 120000)
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: controller ? controller.signal : undefined,
      }).then(function (response) {
        return response.json().catch(function () {
          throw new Error('宿主返回的不是 JSON（HTTP ' + response.status + '）')
        })
      }).finally(function () { clearTimeout(timer) })
    }

    function getJson(url) {
      return fetch(url).then(function (response) {
        return response.json().catch(function () {
          throw new Error('宿主返回的不是 JSON（HTTP ' + response.status + '）')
        })
      })
    }

    function apply(ctx, config) {
      try {
        var React = require('react')
        var slots = ctx.slots
        var t = translator(ctx)

        // ── 主题 token ────────────────────────────────────────────────────
        /**
         * **真实的主题变量是 `--dsw-alias-*`**（见宿主 Theme 服务的 token 表）。
         *
         * ⚠️ 这里曾经写的是 `--dsh-border` / `--dsh-accent` / `--dsh-surface` 之类 ——
         * 那些名字**根本不存在**，所以每个样式都在吃硬编码的兜底色：换主题、切浅色
         * 都跟不上，一眼就看得出不是 DSH 自己的界面。现在全部走真 token。
         */
        var T = {
          bgLayer1: 'var(--dsw-alias-bg-layer-1, #1f2023)',
          bgLayer2: 'var(--dsw-alias-bg-layer-2, #26282c)',
          border1: 'var(--dsw-alias-border-l1, rgba(255,255,255,0.10))',
          border2: 'var(--dsw-alias-border-l2, rgba(255,255,255,0.18))',
          label1: 'var(--dsw-alias-label-primary, #e8e8ea)',
          label2: 'var(--dsw-alias-label-secondary, #9a9ba1)',
          brand: 'var(--dsw-alias-brand-primary, #4b7bf5)',
          error: 'var(--dsw-alias-state-error-primary, #e5544b)',
        }

        // ── 设置页小节 ────────────────────────────────────────────────────
        function Line(props) {
          return React.createElement('div', { style: { color: props.muted ? T.label2 : undefined } }, props.children)
        }

        /** 把宿主返回的生效配置转成界面草稿（大小用 MiB —— 字节对用户不友好）。 */
        function draftOf(payload) {
          const config = payload !== null && typeof payload === 'object' && typeof payload.config === 'object' && payload.config !== null
            ? payload.config
            : {}
          const deep = typeof config.mirrorDeepen === 'object' && config.mirrorDeepen !== null ? config.mirrorDeepen : {}
          const mib = function (bytes) {
            const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
            return Math.max(0, Math.round(value / (1024 * 1024)))
          }
          return {
            workspaceFlow: config.workspaceFlow !== false,
            auditCapacity: typeof config.auditCapacity === 'number' ? config.auditCapacity : 500,
            deepenEnabled: deep.enabled !== false,
            maxFileMiB: mib(deep.maxFileBytes),
            maxTotalMiB: mib(deep.maxTotalBytes),
          }
        }

        /**
         * 设置页小节 —— **真的能改设置**，不只是说明。
         *
         * 改动交给宿主的 `configEditor`（`POST /multi-remote/settings`）：它负责校验、
         * 持久化，并**走正常 Loader 路径重新应用** —— 所以保存之后**插件会重载**，
         * 已连接的远程工作区会断开。这一点必须在界面上说清楚，不能让用户莫名掉线。
         */
        function Section() {
          var [state, setState] = React.useState(null)
          var [draft, setDraft] = React.useState(null)
          var [busy, setBusy] = React.useState(false)
          var [notice, setNotice] = React.useState(null)

          // 打开这一页时读一次当前生效值
          React.useEffect(function () {
            if (state !== null) return
            getJson(ROUTE_SETTINGS)
              .then(function (payload) {
                setState(payload)
                setDraft(draftOf(payload))
              })
              .catch(function (cause) {
                setState({ ok: false, error: String(cause && cause.message ? cause.message : cause) })
              })
          }, [state])

          var body = [
            React.createElement('div', { key: 'title', style: { fontWeight: 600, marginBottom: '6px' } }, t('title')),
            React.createElement(Line, { key: 'summary' }, t('summary')),
            React.createElement(Line, { key: 'connect' }, t('connect')),
            React.createElement(Line, { key: 'flow', muted: true }, t('flow')),
            React.createElement(Line, { key: 'selfcheck', muted: true }, t('selfcheck')),
          ]
          var shell = function (children) {
            return React.createElement('div', {
              style: { padding: '8px 0', fontSize: '12px', lineHeight: 1.7, maxWidth: '520px' },
            }, children)
          }

          if (state === null) {
            body.push(React.createElement('div', {
              key: 'loading', style: { marginTop: '14px', color: T.label2 },
            }, t('loading')))
            return shell(body)
          }

          var editable = state.editable === true && draft !== null
          if (!editable) {
            // 服务不在场（精简 profile）→ **如实说改不了**，并给手工办法，不假装有个开关
            body.push(React.createElement('div', {
              key: 'no-edit',
              style: { marginTop: '14px', fontSize: '11px', lineHeight: 1.7, color: T.label2 },
            }, typeof state.error === 'string' && state.error !== '' ? state.error : t('notEditable')))
            return shell(body)
          }

          var set = function (key) {
            return function (value) {
              setDraft(function (previous) {
                var next = {}
                for (var k in previous) if (Object.prototype.hasOwnProperty.call(previous, k)) next[k] = previous[k]
                next[key] = value
                return next
              })
            }
          }

          function save() {
            setBusy(true)
            setNotice(null)
            postJson(ROUTE_SETTINGS, {
              workspaceFlow: draft.workspaceFlow,
              auditCapacity: Number(draft.auditCapacity),
              mirrorDeepen: {
                enabled: draft.deepenEnabled,
                maxFileBytesMiB: Number(draft.maxFileMiB),
                maxTotalBytesMiB: Number(draft.maxTotalMiB),
              },
            }, 30000)
              .then(function (payload) {
                setBusy(false)
                if (payload && payload.ok === true) {
                  report('settings-saved', true, null)
                  setNotice(t('saved'))
                  return
                }
                report('settings-saved', false, payload && payload.error)
                setNotice(t('saveFailed') + ((payload && payload.error) || t('saveFailedUnknown')))
              })
              .catch(function (cause) {
                var message = String(cause && cause.message ? cause.message : cause)
                setBusy(false)
                report('settings-saved', false, message)
                setNotice(t('saveFailed') + message)
              })
          }

          body.push(React.createElement('div', {
            key: 'divider',
            style: { margin: '16px 0 14px', borderTop: '1px solid ' + T.border1 },
          }))
          body.push(React.createElement(Toggle, {
            key: 'entry',
            label: t('entryLabel'),
            hint: t('entryHint'),
            value: draft.workspaceFlow,
            disabled: busy,
            onChange: set('workspaceFlow'),
          }))
          body.push(React.createElement(Toggle, {
            key: 'deepen',
            label: t('deepenLabel'),
            hint: t('deepenHint'),
            value: draft.deepenEnabled,
            disabled: busy,
            onChange: set('deepenEnabled'),
          }))
          body.push(React.createElement(Field, {
            key: 'maxfile',
            label: t('maxFileLabel'),
            value: String(draft.maxFileMiB),
            placeholder: '2',
            onChange: set('maxFileMiB'),
          }))
          body.push(React.createElement(Field, {
            key: 'maxtotal',
            label: t('maxTotalLabel'),
            value: String(draft.maxTotalMiB),
            placeholder: '64',
            onChange: set('maxTotalMiB'),
          }))
          body.push(React.createElement(Field, {
            key: 'audit',
            label: t('auditLabel'),
            value: String(draft.auditCapacity),
            placeholder: '500',
            onChange: set('auditCapacity'),
          }))
          body.push(React.createElement('div', {
            key: 'reload-warning',
            style: { fontSize: '11px', lineHeight: 1.7, color: T.label2, margin: '4px 0 12px' },
          }, t('reloadWarning')))
          body.push(React.createElement('div', {
            key: 'actions',
            style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
          },
            React.createElement(ActionButton, {
              label: busy ? t('saving') : t('save'),
              primary: true,
              disabled: busy,
              onClick: save,
            }),
            notice === null ? null : React.createElement('div', {
              style: { fontSize: '11px', lineHeight: 1.6, color: T.label2, wordBreak: 'break-word' },
            }, notice),
          ))

          return shell(body)
        }

        // ── 面板里用的小部件 ──────────────────────────────────────────────

        /** 一块可点的动作卡片（主 / 次两种）。 */
        function Btn(props) {
          var primary = props.primary === true
          var disabled = props.disabled === true
          return React.createElement('button', {
            type: 'button',
            disabled: disabled,
            onClick: props.onClick,
            onMouseEnter: function (event) {
              if (!disabled && !primary) event.currentTarget.style.background = T.bgLayer2
            },
            onMouseLeave: function (event) {
              if (!disabled && !primary) event.currentTarget.style.background = T.bgLayer1
            },
            style: {
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '9px 12px',
              marginBottom: '8px',
              borderRadius: '8px',
              fontFamily: 'inherit',
              border: '1px solid ' + (primary ? 'transparent' : T.border1),
              background: primary ? T.brand : T.bgLayer1,
              color: primary ? '#fff' : T.label1,
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled ? 0.55 : 1,
              fontSize: '13px',
            },
          },
            React.createElement('div', { style: { fontWeight: 600 } }, props.title),
            props.hint === undefined ? null : React.createElement('div', {
              style: { opacity: 0.7, fontSize: '11px', marginTop: '2px', wordBreak: 'break-all' },
            }, props.hint),
          )
        }

        /** 弹窗操作栏里的按钮（紧凑型，靠右排）。 */
        function ActionButton(props) {
          var primary = props.primary === true
          var disabled = props.disabled === true
          return React.createElement('button', {
            type: 'button',
            disabled: disabled,
            onClick: props.onClick,
            style: {
              padding: '7px 16px',
              borderRadius: '8px',
              fontFamily: 'inherit',
              fontSize: '12px',
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled ? 0.55 : 1,
              border: '1px solid ' + (primary ? 'transparent' : T.border1),
              background: primary ? T.brand : 'transparent',
              color: primary ? '#fff' : T.label1,
            },
          }, props.label)
        }

        /** 一行输入。 */
        function Field(props) {
          return React.createElement('label', { style: { display: 'block', marginBottom: '10px', fontSize: '12px' } },
            React.createElement('div', { style: { color: T.label2, marginBottom: '4px' } }, props.label),
            React.createElement('input', {
              value: props.value,
              type: props.password === true ? 'password' : 'text',
              placeholder: props.placeholder,
              onChange: function (event) { props.onChange(event.target.value) },
              style: {
                width: '100%',
                boxSizing: 'border-box',
                padding: '7px 9px',
                borderRadius: '8px',
                border: '1px solid ' + T.border1,
                background: T.bgLayer1,
                color: T.label1,
                fontFamily: 'inherit',
                fontSize: '12px',
              },
            }),
          )
        }

        /**
         * 开关（DSH 风格的滑动块）。
         *
         * 为什么不用 `input[type=checkbox]`：宿主主题对原生控件的着色不一致，
         * 而这个页面要和 DSH 自己的设置项长得一样。
         */
        function Toggle(props) {
          var on = props.value === true
          var disabled = props.disabled === true
          return React.createElement('div', {
            style: { display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '14px' },
          },
            React.createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
              React.createElement('div', { style: { fontSize: '12px', fontWeight: 600 } }, props.label),
              props.hint === undefined ? null : React.createElement('div', {
                style: { fontSize: '11px', color: T.label2, marginTop: '3px', lineHeight: 1.6 },
              }, props.hint),
            ),
            React.createElement('button', {
              type: 'button',
              disabled: disabled,
              onClick: function () { props.onChange(!on) },
              'aria-pressed': on ? 'true' : 'false',
              title: props.label,
              style: {
                flex: '0 0 auto',
                width: '36px',
                height: '20px',
                marginTop: '2px',
                borderRadius: '999px',
                border: '1px solid ' + (on ? 'transparent' : T.border1),
                background: on ? T.brand : T.bgLayer2,
                cursor: disabled ? 'default' : 'pointer',
                opacity: disabled ? 0.55 : 1,
                padding: 0,
                position: 'relative',
              },
            }, React.createElement('span', {
              style: {
                position: 'absolute', top: '2px', left: on ? '18px' : '2px',
                width: '14px', height: '14px', borderRadius: '50%',
                background: '#fff',
              },
            })),
          )
        }

        /**
         * 左侧导航里的一行（后端选择）。
         *
         * 做成**左侧竖排**而不是顶部分段控件：弹窗高度固定，竖排能顺带显示
         * 每个后端的**识别结果**（几个发行版 / 几个容器 / 几个用过的连接），
         * 用户一眼就知道该点哪个。
         */
        function NavRow(props) {
          return React.createElement('button', {
            type: 'button',
            onClick: props.onClick,
            style: {
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '7px 10px',
              borderRadius: '8px',
              border: 'none',
              background: props.active ? T.bgLayer2 : 'transparent',
              color: props.active ? T.label1 : T.label2,
              fontFamily: 'inherit',
              fontSize: '12px',
              fontWeight: props.active ? 600 : 400,
              cursor: 'pointer',
            },
          },
            React.createElement('div', null, props.label),
            props.hint === undefined || props.hint === '' ? null : React.createElement('div', {
              style: {
                fontSize: '10px', opacity: 0.75, marginTop: '2px',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, props.hint),
          )
        }

        /** 右侧的一个**可选项**（单选卡片：发行版 / 容器 / 用过的连接）。 */
        function OptionRow(props) {
          var disabled = props.disabled === true
          var active = props.active === true
          return React.createElement('button', {
            type: 'button',
            disabled: disabled,
            onClick: props.onClick,
            style: {
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '9px 12px',
              marginBottom: '6px',
              borderRadius: '8px',
              fontFamily: 'inherit',
              fontSize: '13px',
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              border: '1px solid ' + (active ? T.brand : T.border1),
              background: active ? T.bgLayer2 : T.bgLayer1,
              color: T.label1,
            },
          },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              React.createElement('span', {
                style: {
                  flex: '0 0 auto', width: '13px', height: '13px', borderRadius: '50%',
                  border: '1.5px solid ' + (active ? T.brand : T.border2),
                  background: active ? T.brand : 'transparent',
                  boxShadow: active ? 'inset 0 0 0 2px var(--dsw-alias-bg-layer-1, #1f2023)' : 'none',
                },
              }),
              React.createElement('span', { style: { fontWeight: 600, wordBreak: 'break-all' } }, props.label),
            ),
            props.hint === undefined || props.hint === '' ? null : React.createElement('div', {
              style: { marginLeft: '21px', fontSize: '11px', color: T.label2, marginTop: '3px', wordBreak: 'break-all' },
            }, props.hint),
          )
        }

        /**
         * 「远程开发」弹窗的本体。
         *
         * ## 布局（2026-10-09 第三版）
         *
         * **固定大小**的弹窗，内部两栏：
         *
         * ```
         *   标题栏（标题 + 一句说明）
         *   ┌───────────┬──────────────────────────┐
         *   │ WSL  2 个 │  右侧：该后端的可选项      │
         *   │ SSH  用过 │  （识别出来的，点一下就选）│
         *   │ Docker 3  │                          │
         *   └───────────┴──────────────────────────┘
         *   操作栏（固定在底部）
         * ```
         *
         * 为什么这么排：
         *   - **固定高度**：内容多少都不跳动，操作栏永远在同一位置；
         *   - **左栏**顺带显示每个后端**识别到几个目标**，一眼知道该点哪个；
         *   - **右侧是选项而不是表单**：WSL 发行版、Docker 容器都是**自动识别**出来的，
         *     SSH 用**用过的连接** —— 都不该让用户盲填。识别不到才退回手填兜底。
         *
         * 两步流程（和 VS Code / ZCode 一样）：① 连机器（不填项目根）
         * → ② 看着远程真实目录点选项目文件夹。要第二步是因为：盲填远程根
         * 填错了，连接照样「成功」，但之后每条命令都切不到目录 —— 极难排查。
         *
         * 契约：`{ onClose(), onConnected(workspaceId) }`。
         *
         * ⚠️ **这里没有「打开本机文件夹」** —— 那是 DSH 自己「添加工作区」的活，
         * 不是远程开发的一部分（用户明确提过：本地的操作不该混进来）。
         */
        function ConnectDialog(props) {
          var [step, setStep] = React.useState('pick')     // 'pick' | 'browse'
          var [kind, setKind] = React.useState('wsl')      // 左栏选中的后端
          var [error, setError] = React.useState(null)
          var [working, setWorking] = React.useState(false)
          var [options, setOptions] = React.useState(null)
          // WSL / Docker：**选**出来的目标（不是手填）
          var [distro, setDistro] = React.useState('')
          var [container, setContainer] = React.useState('')
          // 列表长了（容器可能几十个）要能筛
          var [filter, setFilter] = React.useState('')
          // SSH：先看「用过的」，要新建才进表单
          var [sshEditing, setSshEditing] = React.useState(false)
          var [form, setForm] = React.useState({
            host: '', port: '', username: '', privateKeyPath: '', password: '',
          })
          // 「先连机器、再选文件夹」的第二步
          var [machine, setMachine] = React.useState(null)
          var [listing, setListing] = React.useState(null)

          var busy = working

          // 打开就去问宿主：有哪些可选项（识别出来的目标 + 用过的连接）。只问一次。
          React.useEffect(function () {
            if (options !== null) return
            getJson(ROUTE_OPTIONS)
              .then(function (payload) { setOptions(payload && payload.ok === true ? payload : { ok: false, error: (payload && payload.error) || '未知错误' }) })
              .catch(function (cause) { setOptions({ ok: false, error: String(cause && cause.message ? cause.message : cause) }) })
          }, [options])

          /** 关弹窗。忙的时候不给关 —— 否则连接还在跑，界面已经没了。 */
          function close() { if (!busy) props.onClose() }

          /**
           * 重新识别一次（标题栏那个 ↻）。
           *
           * 为什么需要：Docker Desktop 是**按需启动**的 —— 用户看完「守护进程没跑」
           * 的提示、去把它启动起来，回来点一下就该出现容器列表，而不是关掉弹窗再开一遍。
           */
          function reload() {
            setError(null)
            setOptions(null)   // 置空 → 上面那个 effect 会重新拉一次
          }

          // ── 从宿主给的 options 里取「识别结果」 ──────────────────────────
          var targets = options !== null && options.targets !== null && typeof options.targets === 'object' ? options.targets : null
          var wslInfo = targets !== null && targets.wsl !== null && typeof targets.wsl === 'object' ? targets.wsl : null
          var dockerInfo = targets !== null && targets.docker !== null && typeof targets.docker === 'object' ? targets.docker : null
          var distros = wslInfo !== null && Array.isArray(wslInfo.distros) ? wslInfo.distros : []
          var containers = dockerInfo !== null && Array.isArray(dockerInfo.containers) ? dockerInfo.containers : []
          var profiles = options !== null && Array.isArray(options.profiles) ? options.profiles : []
          var sshProfiles = profiles.filter(function (entry) {
            return entry !== null && typeof entry === 'object' && (entry.kind === undefined || entry.kind === 'ssh')
          })
          /** 宿主还没把可选项返回来（弹窗刚打开的那一小会儿）。 */
          var loading = options === null

          /** 探测结果的说明文字（拿不到就说「正在识别」）。 */
          function detailOf(info) {
            if (info === null || typeof info.detail !== 'string' || info.detail === '') return t('detecting')
            return info.detail
          }

          /**
           * 探测**失败**了（而不是「成功但没有」）。
           *
           * 这两种必须分开处理：
           *   - **失败** → 显示原因 + **手填兜底**（否则探测一坏就完全没法连）
           *   - **成功但没有** → 空状态 + 引导（手填没意义：填了也连不上）
           */
          function detectionFailed(info) {
            if (info === null) return true
            return info.status === 'unknown' || info.status === 'error'
          }

          /** 左栏那行的短提示：只给数量，别把整句话塞进去（会被截断）。 */
          function countHint(count, unit, emptyText, info) {
            if (loading) return t('detecting')
            if (count > 0) return count + ' ' + unit
            if (detectionFailed(info)) return t('detectFailed')
            return emptyText
          }

          /** 把一条用过的连接填进表单 —— 凭据（密码）永远要现给。 */
          function useProfile(entry) {
            setForm(function (previous) {
              var next = {}
              for (var k in previous) if (Object.prototype.hasOwnProperty.call(previous, k)) next[k] = previous[k]
              next.host = entry.host === undefined || entry.host === null ? '' : String(entry.host)
              next.port = entry.port === undefined || entry.port === null ? '' : String(entry.port)
              next.username = entry.username === undefined || entry.username === null ? '' : String(entry.username)
              next.privateKeyPath = entry.privateKeyPath === undefined || entry.privateKeyPath === null ? '' : String(entry.privateKeyPath)
              // 档案里**没有凭据**（宿主刻意不回显），密码要重新输
              next.password = ''
              return next
            })
            setSshEditing(true)
          }

          /** 当前选择是否齐全 —— 决定「连接」按钮能不能点。 */
          var ready = kind === 'wsl'
            ? distro.trim() !== ''
            : kind === 'docker'
              ? container.trim() !== ''
              : form.host.trim() !== '' && form.username.trim() !== ''

          /** 容器的显示名：优先名字，拿不到就用 id。**绝不假设字段一定存在**。 */
          function containerName(entry) {
            return typeof entry.name === 'string' && entry.name !== '' ? entry.name : String(entry.id ?? '')
          }

          /** 关键字筛选（大小写不敏感）。 */
          function matchFilter(text) {
            var needle = filter.trim().toLowerCase()
            if (needle === '') return true
            return String(text).toLowerCase().indexOf(needle) >= 0
          }

          /**
           * 渲染一组可选项；**列表长了自动加筛选框**。
           *
           * 为什么需要：容器可能几十个（用户提的「不是只有 docker 这一个，
           * 还有好多别的」）—— 固定高度的弹窗里翻几十行很痛苦。
           */
          function optionList(keyPrefix, entries, activeValue, onPick) {
            var shown = entries.filter(function (entry) { return matchFilter(entry.label) })
            var out = []
            if (entries.length > 8) {
              out.push(React.createElement(Field, {
                key: keyPrefix + '-filter',
                label: t('filterLabel') + '（' + entries.length + ' ' + t('optionCount') + '）',
                value: filter,
                placeholder: t('filterPlaceholder'),
                onChange: setFilter,
              }))
            }
            for (var i = 0; i < shown.length; i += 1) {
              (function (entry) {
                out.push(React.createElement(OptionRow, {
                  key: keyPrefix + '-' + i,
                  label: entry.label,
                  hint: entry.hint,
                  active: activeValue === entry.value,
                  disabled: busy,
                  onClick: function () { onPick(entry) },
                }))
              })(shown[i])
            }
            if (shown.length === 0) {
              out.push(React.createElement('div', {
                key: keyPrefix + '-none',
                style: { fontSize: '11px', color: T.label2, padding: '6px 2px' },
              }, t('filterNoMatch')))
            }
            return out
          }

          /**
           * 第 1 步：**连机器**（不填项目根）。
           *
           * 连上之后进「浏览」视图，让用户**看着远程真实目录**点选项目 ——
           * 路径不再靠盲填（盲填填错会让连接「成功」但每条命令都失败）。
           */
          function connectMachine() {
            setError(null)
            setWorking(true)
            var body = { kind: kind }
            if (kind === 'wsl') body.distro = distro.trim()
            if (kind === 'docker') body.container = container.trim()
            if (kind === 'ssh') {
              body.host = form.host.trim()
              body.username = form.username.trim()
              if (form.port.trim() !== '') body.port = Number(form.port.trim())
              if (form.privateKeyPath.trim() !== '') body.privateKeyPath = form.privateKeyPath.trim()
              if (form.password !== '') body.password = form.password
            }

            postJson(ROUTE_MACHINE_CONNECT, body, 180000)
              .then(function (payload) {
                if (payload && payload.ok === true && payload.machine) {
                  setMachine(payload.machine)
                  report('machine-connected', true, payload.machine.id)
                  setStep('browse')
                  return listDir(payload.machine.id, payload.machine.home)
                }
                setWorking(false)
                setError(t('connectFailed') + ((payload && payload.error) || '未知错误'))
              })
              .catch(function (cause) {
                setWorking(false)
                setError(t('connectFailed') + String(cause && cause.message ? cause.message : cause))
              })
          }

          /** 第 2 步：列一层远程目录。 */
          function listDir(machineId, path) {
            setWorking(true)
            setError(null)
            postJson(ROUTE_MACHINE_LIST, path === undefined ? { machineId: machineId } : { machineId: machineId, path: path }, 60000)
              .then(function (payload) {
                setWorking(false)
                if (payload && payload.ok === true) {
                  setListing(payload)
                  return
                }
                setError(t('listFailed') + ((payload && payload.error) || '未知错误'))
              })
              .catch(function (cause) {
                setWorking(false)
                setError(t('listFailed') + String(cause && cause.message ? cause.message : cause))
              })
          }

          /**
           * 第 3 步：把当前目录作为项目打开（完整连接：镜像 + 预设 + 锚点），
           * 再让宿主把它登记成一个**工作区**，然后关弹窗、切回会话。
           */
          function openProject() {
            if (machine === null || listing === null) return
            setWorking(true)
            setError(null)
            postJson(ROUTE_MACHINE_OPEN, { machineId: machine.id, remoteRoot: listing.path }, 180000)
              .then(function (payload) {
                if (payload && payload.ok === true && typeof payload.anchorPath === 'string') {
                  return adoptWorkspace(payload)
                }
                setWorking(false)
                setError(t('connectFailed') + ((payload && payload.error) || '未知错误'))
              })
              .catch(function (cause) {
                setWorking(false)
                setError(t('connectFailed') + String(cause && cause.message ? cause.message : cause))
              })
          }

          /**
           * 连接已经建好了 —— 再让宿主把锚点目录登记成工作区。
           *
           * **为什么由宿主做**：客户端这边要先 `ctx.get('workspaces')` 再创建，
           * 实测**拿不到**；宿主侧本来就能访问 `workspaceRegistry`，而且**支持标题**
           * （显示成 `ssh:my-proj`，而不是 `mr-ssh-home-user-…`）。
           */
          function adoptWorkspace(connected) {
            return postJson(ROUTE_OPEN_WORKSPACE, {
              anchorPath: connected.anchorPath,
              title: connected.title === undefined ? null : connected.title,
            }, 60000)
              .then(function (payload) {
                setWorking(false)
                if (payload && payload.ok === true) {
                  report('workspace-created', true, payload.title === undefined ? null : String(payload.title))
                  props.onConnected(payload.workspaceId)
                  return
                }
                report('workspace-created', false, (payload && payload.error) || 'unknown')
                setError(t('openWorkspaceFailed') + ((payload && payload.error) || '未知错误'))
              })
              .catch(function (cause) {
                var message = String(cause && cause.message ? cause.message : cause)
                setWorking(false)
                report('workspace-created', false, message)
                setError(t('openWorkspaceFailed') + message)
              })
          }

          function set(key) {
            return function (value) {
              setForm(function (previous) {
                var next = {}
                for (var k in previous) if (Object.prototype.hasOwnProperty.call(previous, k)) next[k] = previous[k]
                next[key] = value
                return next
              })
            }
          }

          var content
          var footer
          if (step === 'browse') {
            // 第 2 步：看着**远程真实目录**点选项目文件夹
            var items = []
            items.push(React.createElement('div', {
              key: 'machine',
              style: { fontSize: '11px', color: T.label2, marginBottom: '8px' },
            }, t('machineConnected') + '：' + (machine === null ? '' : String(machine.target))))
            items.push(React.createElement('div', {
              key: 'path',
              style: {
                fontSize: '12px', fontFamily: 'monospace', marginBottom: '10px',
                wordBreak: 'break-all', padding: '6px 8px', borderRadius: '6px',
                background: T.bgLayer1, border: '1px solid ' + T.border1,
              },
            }, listing === null ? '…' : String(listing.path)))

            if (listing !== null) {
              if (listing.parent !== null) {
                items.push(React.createElement(Btn, { key: 'up', title: '⬆️ ' + t('up'), disabled: busy, onClick: function () { listDir(machine.id, listing.parent) } }))
              }
              var dirs = Array.isArray(listing.dirs) ? listing.dirs : []
              // 上限保护：一个目录可能有上万个条目，别把界面卡死
              var shown = dirs.slice(0, 200)
              for (var di = 0; di < shown.length; di += 1) {
                (function (name) {
                  items.push(React.createElement(Btn, {
                    key: 'dir-' + name,
                    title: '📁 ' + name,
                    disabled: busy,
                    onClick: function () { listDir(machine.id, listing.path + '/' + name) },
                  }))
                })(shown[di].name)
              }
              if (dirs.length > shown.length) {
                items.push(React.createElement('div', { key: 'more', style: { fontSize: '11px', color: T.label2, margin: '4px 0' } },
                  t('tooManyDirs') + '（' + dirs.length + '）'))
              }
              if (dirs.length === 0) {
                items.push(React.createElement('div', { key: 'empty', style: { fontSize: '12px', color: T.label2, margin: '6px 0' } }, t('noSubdirs')))
              }
              items.push(React.createElement('div', { key: 'files', style: { fontSize: '11px', color: T.label2, margin: '6px 0' } },
                String(listing.fileCount ?? 0) + ' ' + t('filesHere')))
            }
            content = items
            footer = [
              React.createElement(ActionButton, {
                key: 'again', label: t('changeMachine'), disabled: busy,
                onClick: function () { setStep('pick'); setMachine(null); setListing(null); setError(null) },
              }),
              React.createElement(ActionButton, {
                key: 'open', label: busy ? t('connecting') : t('openHere'),
                primary: true, disabled: busy || listing === null, onClick: openProject,
              }),
            ]
          } else {
            var pane = []
            var hintLine = function (text) {
              return React.createElement('div', {
                key: 'hint', style: { fontSize: '11px', lineHeight: 1.6, color: T.label2, marginBottom: '10px' },
              }, text)
            }

            if (kind === 'wsl') {
              // 发行版是**识别**出来的（`wsl -l -q`，且不会启动发行版），不用盲填
              if (distros.length > 0) {
                pane.push(hintLine(t('pickDistro')))
                // ⚠️ **全列出来**（与 `wsl -l -q` 一致），系统发行版只**排最后**。
                // 之前是直接隐藏 —— 那会让列表和 `wsl -l -q` 对不上，用户以为插件漏了；
                // 而且「按名字硬编码地隐藏」换个工具就漏判（用户提醒）。
                // 也**不加标注**：用户明确说过那行小字不要（留着可选项就够了）。
                var systemSet = wslInfo !== null && Array.isArray(wslInfo.systemDistros) ? wslInfo.systemDistros : []
                var distroEntries = distros.map(function (name) {
                  var isSystem = systemSet.indexOf(name) >= 0
                  return {
                    label: String(name),
                    value: String(name),
                    systemRank: isSystem ? 1 : 0,
                  }
                }).sort(function (a, b) { return a.systemRank - b.systemRank })
                pane = pane.concat(optionList(
                  'distro',
                  distroEntries,
                  distro,
                  function (entry) { setDistro(entry.value) },
                ))
              } else if (loading) {
                pane.push(hintLine(t('detecting')))
              } else if (detectionFailed(wslInfo)) {
                // **探测失败** → 显示原因 + 手填兜底（否则探测一坏就完全没法连）
                pane.push(hintLine(detailOf(wslInfo)))
                pane.push(React.createElement(Field, {
                  key: 'distro-manual', label: t('fieldDistro'), value: distro,
                  placeholder: 'Ubuntu-24.04', onChange: setDistro,
                }))
              } else {
                // **探测成功但没有** → 空状态 + 引导。
                // ⚠️ 这时**不给**手填框：填了也连不上（那台机器上确实没装发行版），
                //    给个输入框只会让人以为「填对了就能连」。
                pane.push(hintLine(detailOf(wslInfo)))
                pane.push(React.createElement('div', {
                  key: 'no-distro', style: { fontSize: '11px', lineHeight: 1.7, color: T.label2 },
                }, t('noDistroHint')))
              }
            } else if (kind === 'docker') {
              if (containers.length > 0) {
                pane.push(hintLine(t('pickContainer')))
                pane = pane.concat(optionList(
                  'container',
                  containers.map(function (entry) {
                    // 宿主会保证字段是字符串，但**别赌**：这条路径只在渲染期炸，
                    // 而渲染期炸掉的是整个弹窗（实测踩过一次，见 client-half 的渲染测试）。
                    var name = containerName(entry)
                    return {
                      label: name,
                      hint: [entry.image, entry.status].filter(Boolean).join(' · '),
                      value: name,
                    }
                  }),
                  container,
                  function (entry) { setContainer(entry.value) },
                ))
                var chosen = containers.filter(function (entry) {
                  return containerName(entry) === container
                })[0]
                if (chosen !== undefined && chosen.running !== true) {
                  pane.push(React.createElement('div', {
                    key: 'stopped', style: { fontSize: '11px', lineHeight: 1.6, color: T.label2, marginTop: '4px' },
                  }, t('stoppedReadOnly')))
                }
              } else if (loading) {
                pane.push(hintLine(t('detecting')))
              } else if (detectionFailed(dockerInfo)) {
                // 探测失败（守护进程没跑 / 端点不对）→ 原因 + 手填兜底
                pane.push(hintLine(detailOf(dockerInfo)))
                pane.push(React.createElement(Field, {
                  key: 'container-manual', label: t('fieldContainer'), value: container,
                  placeholder: 'my-container', onChange: setContainer,
                }))
              } else {
                // 守护进程好着呢，就是**没有容器** —— 空状态 + 引导。
                // ⚠️ 这时不给手填框：填了也连不上（那台机器上确实没有这个容器），
                //    给个输入框只会让人以为「填对了就能连」。
                pane.push(hintLine(detailOf(dockerInfo)))
                pane.push(React.createElement('div', {
                  key: 'no-container', style: { fontSize: '11px', lineHeight: 1.7, color: T.label2 },
                }, t('noContainerHint')))
              }
            } else {
              // SSH 没有「自动识别」这回事（那需要凭据）—— 用**用过的连接**
              if (!sshEditing && sshProfiles.length > 0) {
                pane.push(hintLine(t('savedProfiles')))
                pane = pane.concat(optionList(
                  'ssh',
                  sshProfiles.map(function (entry) {
                    return {
                      label: String(entry.label || entry.id),
                      hint: [entry.username, entry.host, entry.port].filter(Boolean).join(' · '),
                      value: String(entry.id),
                      raw: entry,
                    }
                  }),
                  null,
                  function (entry) { useProfile(entry.raw) },
                ))
                pane.push(React.createElement(OptionRow, {
                  key: 'ssh-new',
                  label: t('newConnection'),
                  hint: t('newConnectionHint'),
                  disabled: busy,
                  onClick: function () { setSshEditing(true) },
                }))
              } else {
                if (sshProfiles.length > 0) {
                  pane.push(React.createElement('button', {
                    key: 'back-list',
                    type: 'button',
                    disabled: busy,
                    onClick: function () { setSshEditing(false) },
                    style: {
                      border: 'none', background: 'transparent', color: T.label2,
                      cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit',
                      fontSize: '11px', padding: '0 0 10px 0',
                    },
                  }, t('backToList')))
                }
                pane.push(React.createElement(Field, { key: 'host', label: t('fieldHost'), value: form.host, placeholder: '10.0.0.5', onChange: set('host') }))
                pane.push(React.createElement(Field, { key: 'port', label: t('fieldPort'), value: form.port, placeholder: '22', onChange: set('port') }))
                pane.push(React.createElement(Field, { key: 'user', label: t('fieldUsername'), value: form.username, placeholder: 'you', onChange: set('username') }))
                pane.push(React.createElement(Field, { key: 'key', label: t('fieldKeyPath'), value: form.privateKeyPath, placeholder: '~/.ssh/id_ed25519', onChange: set('privateKeyPath') }))
                pane.push(React.createElement(Field, { key: 'pwd', label: t('fieldPassword'), value: form.password, password: true, onChange: set('password') }))
              }
            }

            content = pane
            footer = [
              React.createElement(ActionButton, { key: 'cancel', label: t('cancel'), disabled: busy, onClick: close }),
              React.createElement(ActionButton, {
                key: 'submit', label: busy ? t('connecting') : t('connectMachine'),
                primary: true, disabled: busy || !ready, onClick: connectMachine,
              }),
            ]
          }

          // 左栏只给**短提示**（数量）—— 整句原因放右栏。
          // 之前把整句话塞进来，被截断成「守护进程可用，但没有任何...」（用户实测反馈）。
          var navItems = [
            {
              key: 'wsl',
              label: t('kindWsl'),
              hint: countHint(distros.length, t('distroCount'), t('noneDistro'), wslInfo),
            },
            {
              key: 'ssh',
              label: t('kindSsh'),
              hint: sshProfiles.length > 0 ? sshProfiles.length + ' ' + t('savedCount') : t('sshNoSaved'),
            },
            {
              key: 'docker',
              label: t('kindDocker'),
              hint: countHint(containers.length, t('containerCount'), t('noneContainer'), dockerInfo),
            },
          ]

          // 固定尺寸 + 标题栏 / 两栏主体 / 操作栏 —— 内容多少都不跳动。
          return React.createElement('div', null,
            React.createElement('div', {
              key: 'backdrop',
              onClick: close,
              style: { position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(0,0,0,0.45)', pointerEvents: 'auto' },
            }),
            React.createElement('div', {
              key: 'card',
              style: {
                position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
                display: 'flex', flexDirection: 'column',
                // **固定尺寸**：不随内容变高变矮，操作栏永远在同一位置
                width: '620px', height: '440px', maxWidth: '92vw', maxHeight: '85vh',
                zIndex: 121, borderRadius: '12px', overflow: 'hidden',
                background: 'var(--dsw-alias-bg-overlay, #24262a)',
                border: '1px solid ' + T.border1,
                boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
                color: T.label1, fontFamily: 'inherit',
                // 浮层容器有可能是 pointer-events: none（通知类浮层常见）——
                // 不显式打开的话弹窗就是「看得见、点不动」。
                pointerEvents: 'auto',
              },
            },
              React.createElement('div', {
                key: 'header',
                style: {
                  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                  gap: '12px', padding: '13px 16px', borderBottom: '1px solid ' + T.border1,
                },
              },
                React.createElement('div', null,
                  React.createElement('div', { style: { fontSize: '14px', fontWeight: 600 } }, t('remoteConnect')),
                  React.createElement('div', {
                    style: { fontSize: '11px', lineHeight: 1.6, color: T.label2, marginTop: '3px' },
                  }, t('dialogIntro')),
                ),
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '2px' } },
                  React.createElement('button', {
                    type: 'button',
                    disabled: busy,
                    onClick: reload,
                    title: t('refreshTargets'),
                    style: {
                      border: 'none', background: 'transparent', color: T.label2,
                      cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit',
                      fontSize: '14px', lineHeight: 1, padding: '2px 6px', borderRadius: '6px',
                    },
                  }, '↻'),
                  React.createElement('button', {
                    type: 'button',
                    disabled: busy,
                    onClick: close,
                    title: t('close'),
                    style: {
                      border: 'none', background: 'transparent', color: T.label2,
                      cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit',
                      fontSize: '15px', lineHeight: 1, padding: '2px 6px', borderRadius: '6px',
                    },
                  }, '✕'),
                ),
              ),
              React.createElement('div', {
                key: 'main',
                style: { display: 'flex', flex: '1 1 auto', minHeight: 0 },
              },
                // 第二步（浏览远程目录）时收起左栏，把整幅宽度让给目录列表
                step === 'browse' ? null : React.createElement('div', {
                  key: 'nav',
                  style: {
                    flex: '0 0 150px', width: '150px', padding: '10px 8px',
                    borderRight: '1px solid ' + T.border1, overflowY: 'auto',
                    display: 'flex', flexDirection: 'column', gap: '2px',
                  },
                }, navItems.map(function (entry) {
                  return React.createElement(NavRow, {
                    key: entry.key,
                    label: entry.label,
                    hint: entry.hint,
                    active: kind === entry.key,
                    onClick: function () { setKind(entry.key); setFilter(''); setError(null) },
                  })
                })),
                React.createElement('div', {
                  key: 'content',
                  style: { flex: '1 1 auto', minWidth: 0, padding: '14px 16px', overflowY: 'auto' },
                },
                  error === null ? null : React.createElement('div', {
                    style: {
                      marginBottom: '12px', padding: '9px 11px', borderRadius: '8px',
                      fontSize: '12px', lineHeight: 1.6, wordBreak: 'break-word',
                      color: T.error, background: T.bgLayer1, border: '1px solid ' + T.error,
                    },
                  }, error),
                  content,
                ),
              ),
              React.createElement('div', {
                key: 'footer',
                style: {
                  display: 'flex', justifyContent: 'flex-end', gap: '8px',
                  padding: '12px 16px', borderTop: '1px solid ' + T.border1,
                },
              }, footer),
            ),
          )
        }

        /**
         * 面板的**渲染错误边界**。
         *
         * 为什么需要它（实测教训）：`try/catch` 包住 `createElement` 只能抓到
         * 「创建元素时」的错误，**抓不到组件渲染阶段**的错误 ——
         * 而 React 对渲染期错误没有边界时的处理是**把整棵子树卸载**：
         * 症状就是「点一下整块就消失，毫无反应」（2026-10-07 实测）。
         *
         * 那次事故的直接原因：引用了一个**根本没定义**的组件名
         * （重命名时漏改），`createElement(undefined)` 在渲染期才炸。
         * 所以静态测试会检查「每个大写开头的 createElement 目标都有定义」。
         */
        class PanelBoundary extends React.Component {
          constructor(props) {
            super(props)
            this.state = { failed: null }
          }
          static getDerivedStateFromError(error) {
            return { failed: String(error && error.message ? error.message : error) }
          }
          componentDidCatch(error) {
            report('panel-render-failed', false, error && error.message ? error.message : error)
            console.error('[dsh-multi-remote] 面板渲染失败:', error)
          }
          render() {
            if (this.state.failed !== null) {
              var self = this
              return React.createElement('div', {
                style: { padding: '28px 32px', fontSize: '12px', lineHeight: 1.7 },
              },
                React.createElement('div', { style: { fontWeight: 600, marginBottom: '6px', color: T.error } }, t('renderFailed')),
                React.createElement('div', { style: { color: T.label2, wordBreak: 'break-word', marginBottom: '14px' } }, this.state.failed),
                React.createElement('button', {
                  type: 'button',
                  onClick: function () { self.props.onClose() },
                  style: {
                    padding: '6px 14px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px',
                    fontFamily: 'inherit', border: '1px solid ' + T.border1,
                    background: T.bgLayer1, color: T.label1,
                  },
                }, t('cancel')),
              )
            }
            return this.props.children
          }
        }

        /**
         * 侧边栏导航行的图标。
         *
         * 宿主（`sidebar.panellist` 的所有者）负责画那个按钮、管选中态、渲染标签，
         * 只把 `{ size, active }` 传进来。所以图标必须**用 `currentColor` 描边** ——
         * 颜色交给宿主的选中/悬停状态，这样才和官方那几个图标完全一致。
         * 线框风格（`fill: none` + 1.6 描边）也是照官方的观感来的。
         */
        function RemotePanelIcon(props) {
          var size = typeof props.size === 'number' && props.size > 0 ? props.size : 20
          return React.createElement('svg', {
            width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
            stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
            'aria-hidden': 'true', focusable: 'false',
          },
            // 两台「机器」+ 各自的指示灯与连线 —— 一眼看出是「连到别的机器」
            React.createElement('rect', { x: 3, y: 4, width: 18, height: 6.5, rx: 2 }),
            React.createElement('rect', { x: 3, y: 13.5, width: 18, height: 6.5, rx: 2 }),
            React.createElement('path', { d: 'M6.6 7.25h.01' }),
            React.createElement('path', { d: 'M6.6 16.75h.01' }),
            React.createElement('path', { d: 'M11 7.25h6.5' }),
            React.createElement('path', { d: 'M11 16.75h6.5' }),
          )
        }

        /**
         * 切回会话面板；顺手把刚建好的工作区打开。
         *
         * 连上之后就该直接能用 —— 不该把用户留在一张说明页上。
         * 官方服务拿不到也不影响（工作区已经在侧边栏里了），所以逐级兜底。
         */
        function switchToConversation(workspaceId) {
          try {
            var ui = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
            if (ui !== undefined && typeof ui.openWorkspace === 'function' && workspaceId !== null && workspaceId !== undefined) {
              ui.openWorkspace(workspaceId)
              return
            }
          } catch (cause) {
            console.warn('[dsh-multi-remote] 打开工作区失败（不影响已创建）:', cause)
          }
          try {
            var layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined
            if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel('conversation')
          } catch (cause) {
            console.warn('[dsh-multi-remote] 切回会话面板失败:', cause)
          }
        }

        /**
         * `main` 面板里的**触发器**。
         *
         * 为什么需要它：`sidebar.panellist` 的每一行都**必须**对应一个 `main` 面板
         * （宿主靠同一个 id 配对）—— 少了这一半，那一行点下去就是一片空白。
         * 但我们要的是**弹窗**而不是一整页，所以这一格只做一件事：
         * 打开弹窗，然后立刻把主区域切回会话。
         *
         * 弹窗本体挂在 `shell.overlay`（全窗口浮层）上 —— 它是 root 作用域，
         * 不受主区域切换影响，所以切回去之后弹窗照样在。
         */
        function RemoteTrigger() {
          React.useEffect(function () {
            report('panel-trigger', true, null)
            setDialogOpen(true)
            switchToConversation(null)
          }, [])
          return null
        }

        /**
         * 弹窗宿主 —— 注册在 `shell.overlay` 上。
         *
         * `shell.overlay` 是**全窗口浮层**（root 作用域、列表型加法槽位）：
         * 只有它能盖住整个框架（含侧边栏），而不是被关在中央区域里。
         */
        function RemoteDialog() {
          var [open, setOpen] = React.useState(dialogState.open)

          React.useEffect(function () {
            dialogSubscribers.push(setOpen)
            // 订阅者要能退订：插件卸载 / 热更时不留下悬空引用
            return function () {
              var at = dialogSubscribers.indexOf(setOpen)
              if (at >= 0) dialogSubscribers.splice(at, 1)
            }
          }, [])

          // **诊断信号**：这条上报出现 = 弹窗真的渲染了（浏览器里看不到控制台）。
          React.useEffect(function () { if (open) report('dialog-open', true, null) }, [open])

          if (!open) return null

          return React.createElement(PanelBoundary, { onClose: function () { setDialogOpen(false) } },
            React.createElement(ConnectDialog, {
              onClose: function () { setDialogOpen(false) },
              onConnected: function (workspaceId) {
                setDialogOpen(false)
                switchToConversation(workspaceId)
              },
            }))
        }

        if (slots && typeof slots.inject === 'function') {
          try {
            slots.inject('settings.section', function () {
              return slots.register({
                name: 'settings.section',
                id: 'multi-remote',
                order: 900,
                label: function () { return t('sectionLabel') },
              }, Section)
            })
            report('inject-settings', true)
          } catch (cause) {
            report('inject-settings', false, cause && cause.message ? cause.message : cause)
          }

          // ⚠️⚠️ **必须同步注册**（就在 apply 的生效作用域内）。
          //
          // 第一版把这段写在 `getJson(ROUTE_OPTIONS).then(...)` 里 —— 那是异步回调，
          // **不在插件的生效作用域内**，注册静默失效。
          // 症状极具误导性：界面表现只是「还是官方行为」，没有任何报错，
          // 插槽的占用者查出来还是官方的 `mf`。**实测踩到，别再犯。**
          var enabled = config === undefined || config === null || config.workspaceFlow !== false
          report('workspace-flow', enabled, 'config=' + JSON.stringify(config === undefined ? null : config))
          if (enabled) {
            // 入口 ①：侧边栏的导航行。宿主负责画按钮、管选中态、渲染标签，
            // 我们只交图标组件 —— 所以观感和官方那几项完全一致。
            try {
              slots.inject('sidebar.panellist', function () {
                return slots.register({
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 50,
                  label: function () { return t('remoteConnect') },
                }, RemotePanelIcon)
              })
              report('inject-panellist', true)
              console.info('[dsh-multi-remote] 已注册侧边栏入口（sidebar.panellist，加法式）')
            } catch (cause) {
              report('inject-panellist', false, cause && cause.message ? cause.message : cause)
              console.warn('[dsh-multi-remote] 注册侧边栏入口失败:', cause)
            }

            // 入口 ②：`main` 里那一格**触发器**。keyed 槽位 —— 用一个新 key 就是
            // 多一格，谁也不影响谁。**必须和 ① 一起注册**：少了它，侧边栏那一行
            // 点下去是一片空白（宿主靠同一个 id 配对）。
            // 它自己不画界面 —— 只负责开弹窗，然后把主区域切回会话。
            try {
              slots.inject('main', function () {
                return slots.register({ name: 'main', key: PANEL_ID }, RemoteTrigger)
              })
              report('inject-main-panel', true)
              console.info('[dsh-multi-remote] 已注册面板触发器（main，key=%s）', PANEL_ID)
            } catch (cause) {
              report('inject-main-panel', false, cause && cause.message ? cause.message : cause)
              console.warn('[dsh-multi-remote] 注册面板触发器失败:', cause)
            }

            // 入口 ③：**弹窗本体**，挂在 `shell.overlay`（全窗口浮层）上。
            // 为什么不在主区域里画：那样弹窗会被关在中央区域里，盖不住侧边栏，
            // 看起来就不像个弹窗。`shell.overlay` 是 root 作用域，盖住整个框架。
            try {
              slots.inject('shell.overlay', function () {
                return slots.register({ name: 'shell.overlay', id: PANEL_ID + '-dialog', order: 50 }, RemoteDialog)
              })
              report('inject-overlay', true)
              console.info('[dsh-multi-remote] 已注册弹窗宿主（shell.overlay）')
            } catch (cause) {
              report('inject-overlay', false, cause && cause.message ? cause.message : cause)
              console.warn('[dsh-multi-remote] 注册弹窗宿主失败:', cause)
            }
          } else {
            report('inject-panellist', true, 'skipped: workspaceFlow=false')
            console.info('[dsh-multi-remote] workspaceFlow 已关闭 —— 不注册入口')
          }
        } else {
          report('slots-missing', false, 'ctx.slots 不可用')
        }
        console.info('[dsh-multi-remote] client 半边已加载')
      } catch (error) {
        report('apply-failed', false, error && error.message ? error.message : error)
        console.warn('[dsh-multi-remote] client 半边注册失败（不影响宿主）:', error)
      }
    }

    exports.apply = apply
    /** 需要的客户端服务：slots（UI 插槽）、locale（文案）。 */
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
