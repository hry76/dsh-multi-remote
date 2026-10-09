# 更新日志

本文件记录所有值得注意的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-09

> **首个公开发布版。** SSH / WSL / Docker 三种远程开发全部打通；交互式终端三个后端都
> 实测拿到真 PTY；入口走**宿主的导航行 + 模态弹窗**（图标由宿主画、配色走真 token）；
> **设置 → 远程开发** 能真的改设置；WSL 支持 **busybox 发行版**
> （没有 `bash`、`find` 没有 `-printf` 也能连）。
>
> 这个版本号**之前没有对外发布过** —— 下面两段「开发里程碑」是公开之前的开发过程记录，
> 留在这里是因为它们是决策依据。

### 新增
- **设置页真的能改设置了**（以前只有一段静态说明）：**设置 → 远程开发** 里可以开关
  侧边栏入口、后台补拉镜像与两个上限（MiB）、审计条数上限。
  改动**不自己写文件** —— 走宿主的 `configEditor` 服务（校验 + 持久化 + 走正常 Loader
  路径重新应用），落点是 profile 的 `cordis.patch.yml` 里一条 `id: multi-remote` 的
  **定向覆盖**。界面上**明说**「保存后会重载插件，已连接的远程工作区会断开」——
  不能让用户莫名掉线。没有 `configEditor` 的 profile 会**如实说改不了**并给手工办法，
  不假装有个能用的开关。
- **「先连机器、再选文件夹」的远程开发流程**：连机器时**不用填项目路径**，
  连上后弹出**远程真实目录树**，点进去找到项目再「就用这个文件夹」。
  这消灭了「盲填远程根」这一类问题 —— 填错了连接照样成功、但每条命令都失败，
  非常难排查（真机踩过）。同时新增**连接前校验远程目录存在**：
  路径不对就当场拒绝，并**告诉你同名目录在哪**。
- **界面上的远程开发入口**：侧边栏一行 **远程开发**，点开是一整页
  **「打开文件夹 / 远程开发」**（最终位置与形态见下面的「变更」）。
  「远程开发」连上后**工作区会自动建好**。
  - 两个入口（界面 / agent 调用 `remote_connect`）走**同一套内部实现**，不会漂移
  - 界面与宿主之间走 HTTP 路由（同源自检那套 `fence`），
    请求字段**严格白名单**，凭据**绝不回显**
  - 客户端每一步都**自诊断上报**到宿主（`/multi-remote/client-report`），
    出问题从审计日志就能定位，不用猜
  - `config: { workspaceFlow: false }` 一个开关就能不注册这个入口
- ⚠️ **一次真机事故与它的教训**（过程记录，见 CONTRIBUTING §4.25）：
  这个入口最初做在「工作区」旁 `+` 按钮的选目录流程里 —— 那个流程
  **已有官方归属**（`@deepseek-ai/dsh-client-ui-directory-picker-native`），
  我们一注册，它激活失败，**web boot 起不来，DSH 打不开**。
  已改为完全加法式的侧边栏入口。教训：
  **`replaceRisk: shadows-shipped-ui` 的单占位洞不是空位，是有主的**。

- **镜像：占位文件 + 后台补拉**（解决「界面里点开文件看不到内容」）
  - **占位文件**：超过单文件上限的文件，本地留一个几百字节的说明
    （远端大小 / 完整远端路径 / 怎么查看）。以前是**直接跳过** ——
    那些文件在界面的文件树里**根本不显示**，用户以为不存在。
    实测：一个 69.8 MB 的网格文件现在在树里看得见，点开就知道它在哪、多大、怎么看。
  - **后台补拉**：连上之后在后台把「**文本类**（按扩展名）+ 上限内」的文件补到本地，
    默认单文件 2 MiB / 总量 64 MiB / 120 秒，**不阻塞连接**，断开时中止。
    实测：1.5 GB 的代码仓库补回 **138 个文本文件（3.1 MB）**，
    README / 配置 / 源码点开就有内容；网格/数据库/压缩包不拉（本来也不适合在界面读）。
  - 为什么不做「点开时自动拉」：界面的读文件路径是**宿主独占**的
    （`workspaceFiles` → 宿主的沙箱 fs），插件插不进手 ——
    实测 `ctx.provide('fs', …)` 被拒：`service "fs" has been registered`。
    所以只能在**点开之前**先补到本地。
  - 可关可调：`mirrorDeepen = { enabled, maxFileBytes, maxTotalBytes, maxDurationMs }`

### 变更
- **「远程开发」入口改成宿主的导航行 + 模态弹窗**（`sidebar.panellist` + `main` +
  `shell.overlay` 三个**加法式**槽位）：侧边栏里和官方的「插件」并列一行，点开是一个
  **固定大小**的弹窗（左侧导航 + 右侧内容 + 底部操作栏，内容自己滚）。
  以前是侧边栏底部一个小按钮 + 自造浮层弹窗 —— 位置、留白、选中态、配色都得自己管，
  观感也不像 DSH。现在**图标由宿主画**（我们只交一个 `currentColor` 线框 SVG），
  选中态由宿主管，弹窗挂在全窗口浮层上；连上之后自动关弹窗并切回会话。
- **不再让用户盲填后端目标**（用户提的）：
  - **WSL**：**自动识别**已安装的发行版（`wsl -l -q`，不会启动发行版），列表里点选
  - **Docker**：**自动识别**容器（运行中的排在前面并标出状态）
  - **SSH**：列出**用过的连接**，点一条就填好主机 / 端口 / 账号 / 私钥路径，
    只需再给密码（凭据永不落盘，所以永远要现给）
  - 识别不到时**显示原因**并给**手填兜底**，不让探测失败变成「完全没法连」
  - 新增宿主路由数据：`/multi-remote/connect-options` 现在带 `targets`
    （WSL 发行版 + Docker 容器），由 `src/diagnostics.js` 的 `listTargets()` 提供 ——
    只读、无副作用（列发行版不会启动它）
- **长列表能筛了**（用户提醒「容器不止一个，还有好多别的」）：列表超过 8 项时
  自动出现筛选框（发行版 / 容器 / 用过的连接都适用）；标题栏加了 **↻ 重新识别** ——
  Docker Desktop 是**按需启动**的，启动完点一下就出现容器，不用关掉弹窗再开。
- **把「探测失败」和「成功但没有」分开**（用户实测反馈）：Docker 守护进程好好的、
  只是**没有容器**时，界面却给了一个「容器名或 ID」输入框 —— 填了也连不上，
  只会让人以为「填对了就能连」。现在这两种情况分开：
  - **失败**（守护进程没跑、API 不对）→ 显示原因 + 手填兜底（否则探测一坏就完全没法连）
  - **成功但没有** → 空状态 + 引导（`docker run` / `wsl --install`，然后点 ↻）
  - 左栏的提示改成**只给数量**（`0 个容器` / `没有容器`）—— 之前把整句原因塞进去，
    被截断成「守护进程可用，但没有任何...」
- **「打开本机文件夹」从远程开发里移出**：那是 DSH 自己「添加工作区」的活 ——
  本地目录不属于远程开发流程，混在同一个弹窗里只会让人以为它也是远程的一步。
- **修掉一个一直存在的样式 bug**：客户端里用的 CSS 变量写的是 `--dsh-border` /
  `--dsh-accent` / `--dsh-surface` 之类，而**真实的主题变量是 `--dsw-alias-*`** ——
  那些名字根本不存在，所以每个样式都在吃硬编码的兜底色（换主题、切浅色都跟不上）。
  现在全部走真 token（`--dsw-alias-bg-layer-*` / `-bg-overlay` / `-border-l*` /
  `-label-*` / `-brand-primary` / `-state-error-primary`）。

### 修复
- **WSL 发行版里没有 `bash` 就连不上**（用户实测反馈）：`docker-desktop` 是 busybox，
  **只有 `sh` 没有 bash**，而 WSL transport 把 `bash -lc` 写死了 →
  `execvpe(bash) failed: No such file or directory`。
  现在连接时探测一次用哪个 shell：**优先 bash，没有就退到 `sh -c`**
  （POSIX shell 才是硬要求，bash 只是常见）。两个被测试抓到的细节：
  探测必须**占并发槽位 + 单飞**（否则 16 路并发会冒出 13 个 `wsl.exe`，
  而并发上限 4 是实测底线）；致命错误（`E_DISTRO_NOT_FOUND`）与**超时照旧上抛**，
  不能被当成「这个 shell 没有」—— 那是谎报原因。
- **busybox 的 WSL 发行版列目录失败**（同一个发行版实测）：
  `find: unrecognized: -printf`（BusyBox v1.37）。WSL 的 `stat`/`readdir` 脚本
  原来用的是 GNU 写法 —— **Alpine-on-WSL 这种正经开发环境同样会挂**。
  现在两条路都有：GNU 走 `-printf`（NUL 分隔，文件名含换行也不怕），
  busybox 退到 `-exec + stat -c`，**字段顺序完全一致**（宿主侧解析器一行没改）。
  顺带实测出一件反直觉的事：**`stat -c` 不解释 `\0`**（busybox 与 GNU 都原样输出
  `\0` 这两个字符），只有 `--printf` 才解释 —— 所以 busybox 退路的 NUL 由
  `printf` 自己产出。真机验证：busybox 的 `docker-desktop` 与 GNU 的 `Ubuntu-24.04`
  列目录都通过。
- **弹窗打不开（显示出错了）**：弹窗**第一帧**读了一个 `null` 的属性
  （`wslInfo.systemDistros` —— 可选项还没从宿主返回时 `wslInfo` 是 `null`），
  渲染期抛错 → 错误边界把整个弹窗换成了错误面板，用户看到的就是「打不开」。
  现在加了空值守卫，并给测试装了**极简渲染器**（真的把元素树走一遍、真的调用组件），
  专门抓这类「只在渲染期才发生」的错误 —— 静态检查与只调 `apply` 的测试都抓不到它。
  新测试用**负对照**验证过：去掉守卫立刻变红。
- **「用过的连接」一直是空的**（用户实测反馈）：两步流程（连机器 → 选文件夹）
  **一条档案都不存** —— 只有 `remote_connect` 工具那条路会存。于是界面里那个列表
  永远没东西，用户每次都要把主机 / 端口 / 账号 / 私钥路径重敲一遍。
  现在连机器成功就存一条**机器级档案**（`machine: true`，**没有项目根** ——
  那是第二步选出来的），SSH 面板据此一键填好。
- **WSL 列表里冒出 `docker-desktop`**（用户实测反馈）：它是 Docker Desktop
  自己装的 WSL 发行版（引擎 VM）—— 但**它确实是货真价实的 WSL2 发行版**
  （注册表 `Lxss` 里有 BasePath、`wsl -l -v` 列得出来）。
  所以**不隐藏**：列表与 `wsl -l -q` 完全一致，`docker-desktop` 只是**排在最后**
  （它没有 bash、用的是 busybox，所以还顺带促成了上面两条修复）。
  （最初一版是直接隐藏 —— 那会让列表和 `wsl -l -q` 对不上，用户会以为插件漏了；
  而且「按名字硬编码地隐藏」换个工具就漏判。中间一版加了「系统发行版」的标注，
  用户说那行小字不要，已去掉。）
- **私钥路径的边界写清楚了**：`privateKeyPath` 从「凭据清单」里移出 ——
  它是**路径**不是凭据（认证不了任何人），而「用过的连接」正需要它才能填满。
  私钥**内容** / 口令 / passphrase 仍然永不回显；测试改成**按键名匹配**
  （`privateKey` 是 `privateKeyPath` 的子串，原来的 `includes` 判法本身就不可靠）。
- **远程会话补齐了「读文件 / 写文件 / 编辑 / 搜索 / AGENTS.md / 计划」等全部能力**
  （最重要的一条）。原先远程预设只挂了 `tool-bash`，所以**远程会话里模型只有
  bash 和终端** —— 不能读写文件、不能搜索，也读不到 `AGENTS.md`。
  现在预设与宿主默认预设对齐（5 行 → 15 行），且都挂在隔离域内，
  所以「读/写/编辑」整体变成**远程**操作。
- **`glob` / `grep` 现在真的在远程执行了**。原先它们用的是宿主自带的那两个
  （`@deepseek-ai/dsh-tool-fs-search`），而那两个用**打包在宿主里的 ripgrep** +
  `subprocess` 接缝 —— 跑在你本机、搜的是**本地镜像**：
  **大于 256 KiB 的文件、超过 12 层 / 2 万条目之外的部分根本搜不到，
  而且不会告诉你漏了**。这与「工作区在远程」是矛盾的。
  现在由 `src/world/search.js` 自己实现，在隔离域内用远程的 `find` / `grep`。
  **实测判据**：在一个 **328 KB 的文件**里搜到了内容，而那个文件
  **本地镜像里压根没有**（镜像对 >256 KiB 只留占位）。
  与宿主那份的差异（POSIX 正则方言、内置剪枝名单而非远程 `.gitignore`、
  截断而非 spill 文件）都写进了工具描述，不静默。
- **文档与实现对齐**（2026-10-09，纯文档）：清掉几处会误导外部读者的过期描述 ——
  `package.json` 的 `description` 还写着「骨架阶段，尚未实现连接能力」（功能其实全做完了）；
  README 关于「超过 256 KiB 的文件」自相矛盾（一处说「留占位」、另一处说「本地根本没有」）——
  实际是**留占位**，且后台补拉会把文本类的**换成真内容**；README 的测试规模
  （409 默认 + 12 真机 = 423）已过时，现为 **474 + 14 = 488**。

## 开发里程碑：M1–M4（2026-10-06，未发布）

> 三个后端全部打通、交互式终端拿到真 PTY 的那一轮。

### 新增
- **审计日志**（`src/audit.js` + `GET /multi-remote/audit`）：记**面向操作**的轨迹
  —— 连过哪些机器、成没成、失败原因、**栅栏拒绝**（安全事件）。
  三条约束：**有界**（环形缓冲，默认 500 条）、**绝不落凭据**（统一脱敏，
  含错误信息与 URL 里的 token）、**绝不抛错**（审计坏了不能让连接失败）。
  支持 `?limit=` / `?event=` 过滤与 `?clear=1` 清空。
- **自检报告后端可用性**（`src/diagnostics.js`）：`/multi-remote/selfcheck` 现在会
  先回答「这台机器上哪种后端能用」（SSH 客户端 / WSL 发行版 / Docker 守护进程），
  再谈具体连接。三个探测并行（约 50 ms），探不到时带上原始错误；
  `?backends=0` 可跳过。
- **交互式终端**（`remote_terminal` 工具 + `src/terminal/`）：**三个后端都支持**，
  开的是**真 PTY**（Docker / WSL 实测拿到 `/dev/pts/N`），不是管道。
  状态跨调用保留（`cd`、环境变量、函数、后台任务），有界滚动缓冲 + 分页读，
  **`SIGINT` 真的能打断前台命令**。走宿主的 `TerminalBackend` 接口，
  所以身份 / 授权 / 清理 / 界面终端 UI 全部白拿。
  - `src/terminal/session.js`：与后端无关的会话机械（滚动缓冲、就绪判定、可取消的发送）
  - `src/terminal/backends.js`：SSH（ssh2 `shell()`）/ Docker（`exec` + `Tty`）/
    WSL（`script -qec` 分配 PTY）
  - `src/terminal/backend.js`：宿主 `TerminalBackend` 适配
  - `src/terminal/tool.js`：模型可见的 `remote_terminal` 工具
- **Docker 后端**（`src/transport/docker.js`）：**直连 Docker Engine API**（不依赖 `docker` CLI，
  零 npm 依赖 —— 用 Node 内置 `http` 连命名管道）。**只连已运行的容器**（不创建、不启动），
  **不需要任何凭据**。文件内容走 `archive` 端点（不依赖容器里的工具），元数据走 exec。
- `src/transport/tar.js`：最小 ustar 编解码（archive 端点的载荷是 tar，而项目零依赖）
- **WSL 后端**（`src/transport/wsl.js`）：驱动 `wsl.exe`，**exec-only**
  （文件操作全在发行版内部完成，不走 UNC —— UNC 又慢又失真，见「修复」）。
  **不需要任何凭据**；并发硬限流 4 + FIFO 队列；取消走 SIGTERM。
- 连接档案支持 `kind: 'ssh' | 'wsl' | 'docker'`
  （`remote_connect` 新增 `kind` / `distro` / `wslUser` / `container` / `dockerPipe`）
- **安装器**（`scripts/install.mjs`）：写构建脚本表态 → 安装 → **回读校验插件真的被登记**。
  修掉「装了但不加载」这个静默失败模式（见「修复」）。
- `Transport` 契约与错误分类（`src/transport/transport.js`）
- **SSH 后端**（`src/transport/ssh.js`）：连接、host key TOFU（变更一律拒绝）、
  `exec`（超时 / 取消 / 非零退出码如实回报）、SFTP 读 / 原子写 / stat / readdir / realpath
- 隔离域 provider：`src/world/fs.js`（`ctx.fs` 的远程实现）、`src/world/shell.js`（`ctx.shell` 的远程实现）
- 预设注册骨架（`src/session/preset.js`）：运行时 `agentPresets.register()`、
  **注册后回读诊断**、不可用时拒绝会话（绝不静默降级到本机）
- 镜像层（`src/mirror/`）：锚点目录的只读镜像 —— 格局层（目录树 + 小文件）、
  照片层（agent 读写时顺手同步，零额外网络开销）、手动刷新
- 锚点目录自动 `git init` + 基线提交（宿主的改动对比依赖它）
- 连接管理与会话绑定（`src/session/connection.js`、`src/session/binder.js`）：
  连接时建镜像并注册预设，会话创建时按锚点目录绑定远程预设
- 工具：`remote_connect` / `remote_profiles` / `remote_list` / `remote_disconnect` / `remote_refresh`
- 连接档案持久化：只存非敏感字段（主机、账号、路径、私钥**路径**）；
  口令与私钥内容**永不落盘**，每次连接现给
- **HTTP 路由栅栏**（`src/http/fence.js`）：Host / Origin / Sec-Fetch-Site 校验，fail-closed

### 变更
- **新增运行时依赖 `ssh2`**（唯一一个）。它的原生加速 `cpu-features` **被显式拒绝构建**
  （`pnpm-workspace.yaml` 的 `allowBuilds`），所以本插件**零原生依赖** ——
  没有 C++ 工具链的用户也能直接装上。

### 修复
- **`glob` / `grep` 现在真的在远程执行了**。原先它们用的是宿主自带的那两个
  （`@deepseek-ai/dsh-tool-fs-search`），而那两个用**打包在宿主里的 ripgrep** +
  `subprocess` 接缝 —— 跑在你本机、搜的是**本地镜像**：
  **大于 256 KiB 的文件、超过 12 层 / 2 万条目之外的部分根本搜不到，
  而且不会告诉你漏了**。这与「工作区在远程」是矛盾的。
  现在由 `src/world/search.js` 自己实现，在隔离域内用远程的 `find` / `grep`。
  **实测判据**：在一个 **328 KB 的文件**里搜到了内容，而那个文件
  **本地镜像里压根没有**（镜像对 >256 KiB 只留占位）。
  与宿主那份的差异（POSIX 正则方言、内置剪枝名单而非远程 `.gitignore`、
  截断而非 spill 文件）都写进了工具描述，不静默。
- **远程会话补齐了「读文件 / 写文件 / 编辑 / 搜索 / AGENTS.md / 计划」等全部能力**
  （最重要的一条）。原先远程预设只挂了 `tool-bash`，所以**远程会话里模型只有
  bash 和终端** —— 不能读写文件、不能搜索，也读不到 `AGENTS.md`。
  现在预设与宿主默认预设对齐（5 行 → 15 行），且都挂在隔离域内，
  所以「读/写/编辑」整体变成**远程**操作。
- **`world/fs` 现在也认「本机锚点路径」**：`read`/`write`/`edit` 会把会话 cwd
  （= 本机锚点目录）作为路径或基准传下来，原先会被拼成远程根本不存在的路径。
  翻译逻辑与 `world/shell` 共用一份实现。
- **交互式终端：首次发送前先等登录 banner 打完**。登录 banner（motd、
  「需要重启系统」这类提示）在 shell 到提示符之前会持续输出，而 PTY 会**立刻回显**
  我们写进去的字节 —— 于是「已回显 + 一个短暂的间隙」被误判成「命令跑完了」，
  拿到的输出里只有 banner 和命令回显、**没有命令真正的输出**。
  现在首次发送前会等终端安静（= 到了提示符）再写；一直不安静也照常发送，
  但结果里如实标 `readyReason: 'not-quiet-yet'`。已经安静的终端几乎不增加延迟。
- **SSH 断线自动重连**：SSH 是长连接，网络抖动 / 服务端重启 sshd / NAT 表项过期
  都会让通道断掉，此后每个操作都失败。现在会**自动重连一次**。
  关键区分：**连上过又断了**才重连；**从没调用过 `connect()`** 时绝不偷偷连上去
  （那等于用户没让我们连，我们却静默建立了 SSH 连接）。
- **重连时 host key 校验仍然生效**（安全红线：不能因为重连就放行）。
- **Docker 引擎重启后自动重连**：Docker Desktop 自动更新会让引擎重启、旧命名管道失效，
  此后每个操作都失败，而错误信息看起来像「配置错了」。现在连接层失败会自动重连一次
  （只一次、只对连接层失败；`NOT_FOUND` 这类操作的正常结果不重试）。
- **Docker 错误信息不再出现 `[object Object]`**：守护进程的错误体是 `{"message":"..."}`，
  之前被 `String()` 一转换就丢了内容。现在统一解析，并把两个状态码分开归类：
  **409**（容器没在运行 → 提示 `docker start`）与 **404**（容器不存在）。
- **设置页显示过时的占位文案**：一直写着「尚未实现任何连接能力」，
  还指着一个**早就不存在**的工具名（`multi_remote_hello`）。功能全做完了界面却说自己
  什么都没做 —— 比没有界面更坏。现在显示真实状态（支持三种后端、怎么连接、
  以及「先开工作区再建会话」的顺序约束）。
- **客户端半边接入宿主 i18n**：文案走 `ctx.locale`，注册中英双份字典
  （宿主强制双语平衡，缺一份会抛错）；拿不到 locale 时退回内置文案，不让设置页空白。
- **「装了但不加载」**：pnpm 11+ 拒绝未表态的构建脚本时会以非零退出码失败，
  而 `dsh plugin` 只在安装成功时才登记 `dsh.profile.bundles` ——
  结果是包进了 `node_modules` 却永远不加载，且没有任何提示。
  安装器现在会先写表态、再安装、最后**回读校验**；没登记就非零退出。
- **远程会话的命令会落在本机**：`agent.ctx` 解析到的是全局 `ctx.shell`，
  所以工具必须注册在**隔离域内**才用得上远程实现；同时把工具的默认 `cwd`
  （会话工作目录 = 本机锚点路径）翻译成远程路径，否则远程 `cd` 直接失败。
- **host key 每次误报「中间人攻击」**：`ssh2` 在 `hostHash: 'sha256'` 下给的是
  **摘要的 hex 编码**，必须重新编码成 base64，不能重复哈希。
- `ssh2` 缺失时给出可执行的提示，而不是光一句 `ERR_MODULE_NOT_FOUND`。
- **WSL 不用 UNC 做 transport**：`\\wsl.localhost\...` 上宿主 git 每个轮次要 20 秒以上
  （2077 文件仓库 `git status` 4.9s、`git diff --numstat` 18.6s），
  且符号链接不可达、元数据伪造（mode 恒 0666）、`fs.watch` 直接 EISDIR。
  改为全部在发行版内部用一次 `wsl.exe -e` 完成。
- **Docker 读符号链接会拿到空内容**：archive 端点返回的是**链接本身**（数据为空），
  不跟随目标。改为先 `realpath` 再重取，并加嵌套深度上限防成环。
- **Docker 目录会被当成普通文件读**：`mode` 是 Go 的 `os.FileMode`（目录 bit31、
  符号链接 bit27），不是 POSIX `st_mode`。已按正确的位判定。
- **Docker 会把「还在跑」报成成功**：退出码改为必须 `Running === false` **且**
  `ExitCode` 非 null；拿不到就如实报超时（原先的 `ExitCode ?? 0` 会把失败报成成功）。
- **Docker 守护进程的错误被吞掉**：多路复用流的 `streamType` 有 4 种，
  其中 **3 = Systemerr** 是守护进程自己的错误流，现已单独收集并记日志。
- **给容器写的文件是空的**：`脚本 + heredoc` 的写法会被脚本末尾的 `exit` 提前截断。
  内容改为内联在同一个脚本里。
- **alpine 容器上列目录会失败**：busybox 的 `find` **没有 `-printf`**（`stat` 也没有
  `--printf`）。`readdir` 改为 `find -exec stat -c ... + | tr '\n' '\0'` ——
  busybox 与 coreutils 双兼容，且仍是一次调用拿全。
- **容器没在运行时被一刀切拒绝**：实测 archive 端点对**已停止**的容器也能用，
  所以「没在运行就拒绝连接」过严。改为允许连接但标注只读，并把
  「没在运行」（去 `docker start`）与「没 shell」（换镜像）两种失败**分开报** ——
  这两种的修法完全不同。
- **容器里没有 shell 时，写文件/列目录的报错含糊**：现在明确说明原因，
  并指出文件**内容**读写仍然可用（走 archive）。
- **Docker 大文件写入有 128 KiB 硬上限**（这条最严重）：原实现把内容内联进
  `bash -c` 的 argv，而 Linux 的**单个参数**上限是 `MAX_ARG_STRLEN` = **131 072 字节**
  （与 `ARG_MAX` 无关）。实测原子路径最大只能到 98 217 字节；再往上落到不原子的兜底；
  64 MiB 时甚至把 dockerd OOM 杀掉、整个 Docker Desktop 挂掉。
  改为**内容走 `archive` 端点的 tar 请求体 + 容器内 `mv -f`**：
  128 KiB 悬崖消失，16 MiB 从 4502 ms → **1170 ms（快 3.8 倍）**，**且恢复了原子性**。
- **Docker 写文件的临时目录泄漏**：原兜底路径每次写都留一个 `/tmp/dsh-mr-upload-*`
  暂存目录（实测 15 分钟攒了 31 个）。新实现不再需要暂存目录。
- **终端的 `SIGINT` 打不断前台命令**：原实现去容器里按 pgid `kill`（不可靠，
  容器里未必有 `ps`）。改为**往 PTY 写控制字符**，让行规程把 Ctrl-C 变成发给
  前台进程组的信号。实测改完 `SIGINT` 能在 638 ms 内打断 `sleep 30`。
- **`read()` 的 `truncated` 语义错了**：原本把「这次分页没覆盖到开头」也算进去，
  于是每次正常分页都报「被截断」。现在只表示「滚动缓冲丢过行」。
- **Docker 在 macOS / Linux 上完全不可用**：`DockerClient` 把 Windows 命名管道写死了，
  而 `http.request` 的 `socketPath` 在类 Unix 上要的是 `/var/run/docker.sock`。
  现在按平台自动选端点，并支持 `DOCKER_HOST` 的 `npipe://` / `unix://`；
  **`tcp://` 与 `ssh://` 明确报「不支持」**，不假装能连。

### 计划中
- Docker over TCP / TLS（需要 TLS 与额外协议栈）
- Windows 容器（目标环境要求 POSIX shell）
- 界面上的诊断页（当前用 `/multi-remote/selfcheck` 路由）

## 开发里程碑：M0 骨架（2026-10-05，未发布）

### 新增
- 插件骨架：`package.json` 清单、`cordis.patch.yml` bundle 挂载声明
- 宿主半边 `src/index.js`：`multi_remote_hello` 工具 + `/multi-remote/ping`、`/multi-remote/selfcheck` 两条自检路由
- 客户端半边 `src/client.js`：设置页「远程开发」小节
- 开源工程文件：`README.md`、`CONTRIBUTING.md`、`LICENSE`、`.gitignore`

[Unreleased]: https://github.com/jk-uzi/dsh-multi-remote/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jk-uzi/dsh-multi-remote/releases/tag/v0.1.0
