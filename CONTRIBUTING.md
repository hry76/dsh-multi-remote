# 贡献指南

感谢参与。本文件写给**第一次接触这个仓库的人**：怎么把环境跑起来、代码要遵守什么约定、以及几个会浪费你半天的坑。

## 1. 环境准备

需要一个可用的 DSH（DeepSeek Harness）环境：

- **DSH Desktop**：安装目录下 `resources/runtime/cli/bin/dsh.cmd` 就是 CLI。
- **npm 版**：`dsh` 在 PATH 里。

两者都支持本插件。开发期建议用**隔离 profile**（见下），不要动你日常在用的 profile。

## 2. 本地开发

```bash
# 隔离 DSH_HOME（放在仓库外）
export DSH_HOME="$HOME/.dsh-multi-remote"
# Windows PowerShell: $env:DSH_HOME = "$HOME\.dsh-multi-remote"

# 建隔离 profile 并挂载本仓库
dsh --profile dev --from-default-profile web --dump-config
dsh plugin --profile dev add "link:$PWD"

# 启动（改代码后重启）
dsh --profile dev --no-open --port 19388
```

验证：

```bash
curl http://127.0.0.1:19388/multi-remote/selfcheck
# {"ok":true,...,"registered":true,"visibleToModel":true,...}
```

> **本仓库没有构建步骤**：宿主直接加载 `src/index.js` 与 `src/client.js`。
> 除非将来引入 TS 或前端框架，否则请不要引入构建链。

### 跑测试

```bash
node --test          # 自动发现 test/ 下的 *.test.mjs
```

`test/static-contract.test.mjs` 是一道**静态闸门**：不启动 DSH，只检查那些「一错就让插件装不上、或让整个 harness 起不来」的硬约束（身份标识一致、peer 依赖已声明、路由唯一、无本机路径泄漏等）。**提交前请确保它全绿。**

## 3. 插件 API 契约

### 3.1 入口形状

```js
export const name = '@jk-uzi/dsh-multi-remote'    // 插件身份，与包名一致
export const inject = ['webServer', 'tools']    // 依赖的宿主服务
export function apply(ctx, config) { /* ... */ }
```

`name` / `inject` / `Config` 都是可选的；只要有 `apply` 就会被识别为插件。

### 3.2 注册模型工具

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'multi_remote_hello',
  description: '……',
  parameters: { who: { type: 'string' } },      // DSL：扁平 map
  output: {
    schema: { type: 'object', properties: { message: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: value.message }],
  },
  async execute(args, exec) { return { message: `hi ${args.who}` } },
}))
```

- `ctx.tools.register()` **返回 disposer**，惯例是 `ctx.effect(() => ctx.tools.register(...), label)`。
- `defineTool` 白送**入参校验**；如果直接用 raw JSON Schema 调 `ctx.tools.register(def)`，则**没有入参校验**（`required` 要写成字符串数组，不是 `required: true`）。
- 工具名 `run_code` 是保留字，不能占用。

### 3.3 注册 HTTP 路由

```js
ctx.effect(() => ctx.webServer.register({
  kind: 'exact',            // 'exact' | 'prefix'
  path: '/multi-remote/ping',
  handler: (req, res) => { res.writeHead(200, {...}); res.end('...') },
}), 'dsh-multi-remote: /multi-remote/ping')
```

- 同一个 `(kind, path)` **重复注册会直接抛错**，并让整棵插件树启动失败——路径必须全局唯一。
- handler 拿的是原生 `node:http` 的 `req` / `res`，响应完全自己写。

### 3.4 客户端半边

`src/client.js` **不是 ESM**，而是手写的懒 CJS 包：

```js
window.__ModuleLoader__.load({
  id: '@jk-uzi/dsh-multi-remote',             // 必须等于包名
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    function apply(ctx) { /* ctx.slots / ctx.locale ... */ }
    exports.apply = apply
    exports.inject = ['slots', 'locale']    // 客户端 cordis 服务名，不是包名
    return module.exports
  },
})
```

宿主按 `package.json` 的 `exports['./client']` 定位文件，服务出去的 URL 是 `/plugins/<包名>/client.js`。

## 4. 最容易踩的坑

### 4.1 安装：pnpm 构建脚本表态（会让插件「装了但不加载」）

pnpm 11+ 默认拒绝任何「没提前表态」的依赖构建脚本，并且**以非零退出码失败**：

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: cpu-features@0.0.10, ssh2@1.17.0
```

而 `dsh plugin` **只在安装成功时才把插件登记进 `dsh.profile.bundles`**。于是：

```
node_modules/@jk-uzi/dsh-multi-remote  ← 装上了
dsh.profile.bundles                    ← 没有它 → 永远不加载，且没有任何提示
```

**本仓库的表态**（`pnpm-workspace.yaml`）：`ssh2` 与 `cpu-features` 都**拒绝构建**。
理由是 `ssh2` 是纯 JS 实现、不构建不影响功能（已实测），而 `cpu-features` 需要
C++ 工具链、会让部分用户装不上。所以本插件零原生依赖。

真正需要表态的是**用户的 profile 目录**（`dsh plugin add` 在那里跑 pnpm）。
用自带安装器一次做对：

```bash
node scripts/install.mjs --profile <你的 profile>
```

它会写入表态 → 安装 → **回读校验 bundle 真的被登记**，没登记就非零退出。

### 4.2 宿主注入的包必须写进 `peerDependencies`

**宿主注入的 `@deepseek-ai/*` 包，必须写进 `package.json` 的 `peerDependencies`。**

DSH 宿主按**插件清单里声明的依赖**做裸包名路由。只 `import` 不声明的话，插件会在启动时报：

```
multi-remote (@jk-uzi/dsh-multi-remote): failed to import
# 底层：ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'
```

这些包只存在于宿主的 `app.asar` 内，profile 里没有，所以靠 Node 自身的向上查找是找不到的。**新增任何 `@deepseek-ai/*` 导入时，同步补 `peerDependencies`。**

另外：**不要写 `dsh.compatibility.dshReleases`**——该字段在当前 DSH 版本里不存在。兼容性判定看的是 `peerDependencies` 里 `@deepseek-ai/dsh-*` 的 semver 范围。

**范围必须写成跨线开区间，不能用 caret。** DSH 在 import bundle **之前**校验所有 `@deepseek-ai/dsh-*` peer，**任一条不匹配就整包丢弃**——表现为「升级 DSH 后插件整个不见了」。而 caret 在 `0.x` 上锁死小版本线（`^0.2.0` 容不下 `0.3.x`）。所以要写：

```json
"@deepseek-ai/dsh-tools": ">=0.2.0-rc.2 <0.3.0"
```

`@deepseek-ai/cordis` 不参与该校验，保持 caret 即可。这两条都有静态闸门盯着。

### 4.3 预设隔离：工具必须挂在隔离域**内**

远程会话的执行世界靠**预设隔离**：在预设的隔离域里把 `fs` / `shell` 换成远程实现。

但**光换 provider 不够**——工具必须**也挂在这个域内**：

- `agent.ctx` 解析到的是**全局**（本机）`ctx.shell`（实测）。
- 工具捕获的是它**挂载时所在 scope** 的服务。
- 所以在域外注册工具 = 命令落在本机；不注册 = 远程会话根本没有能跑命令的工具。

同理，工具的默认 `cwd` 是**会话工作目录**（本机锚点路径），必须翻译成远程路径，
否则远程 `cd` 直接失败。

### 4.4 host key 指纹的格式

`ssh2` 在 `hostHash: 'sha256'` 下交给 `hostVerifier` 的**不是原始密钥，也不是 base64 指纹**，
而是**摘要的 hex 编码**。必须**只重新编码成 base64，不能再哈希一次**——
搞错的表现是「每次连接都误报中间人攻击」。

### 4.5 Windows 上 spawn `.cmd`

Node 18.20+/20.12+/22+ 出于安全考虑**不再允许直接 `spawn` `.cmd` / `.bat`**（抛 `EINVAL`）。
DSH Desktop 的 CLI 恰好是 `dsh.cmd`。安装器会把批处理壳解析成真正的 exe + 脚本
（顺便展开 `%~dp0`），从而完全绕开 shell。

### 4.6 WSL：并发必须 ≤ 4，且**绝不 SIGKILL `wsl.exe`**

这条是**实测踩出来的**，代价是 WSL 服务被打死、需要提权重启。

- 每次 `wsl.exe` 调用有 **~106 ms** 固定开销，所以「一个文件一次调用」不可用。
- 并发 **1–4 路正常**；**8 路以上出现 30 秒级停顿与 50–87% 失败率**。
- 更激进的突发（64 路）+ SIGKILL 在途实例会把 **WSL relay 彻底打死** ——
  之后 `wsl -l -v`、`wsl --terminate`、`wsl --shutdown` **全部超时**，
  只能提权 `Restart-Service WslService` 或重启机器。

所以 `WslTransport` 里 `MAX_CONCURRENT = 4` 是**硬限流**（带 FIFO 队列），
取消走 SIGTERM，并且测试里有负对照盯着。

### 4.7 WSL：不要用 UNC 路径做 transport

`\\wsl.localhost\<distro>\...` 看起来是「真实本地路径」，但实测表明它**又慢又失真**：

| 问题 | 实测 |
|---|---|
| 宿主 git 极慢 | 2077 文件仓库：`git status` **4.9s**、`git diff --numstat` **18.6s** |
| 符号链接不可达 | `lstat`→EISDIR、`stat`→ENOENT、`readlink`→EISDIR；`/bin`、`/lib`、`/sbin` 进不去 |
| 元数据是编的 | `mode` 恒 0666、uid/gid 恒 0 |
| `fs.watch` 不可用 | → EISDIR |
| 逐文件开销 | ~0.8 ms/stat（本地 NTFS ~0.008 ms，约 **100×**） |

所以 WSL 后端的文件操作**全部在发行版内部**用一次 `wsl.exe -e` 完成。

### 4.8 WSL：`wsl.exe` 的输出编码与错误通道

- `wsl.exe` **自己**的消息（`-l -q`、`--status`、致命错误）是 **UTF-16LE 无 BOM**
- **子进程**输出是原始 UTF-8
- 一次调用可能两种编码都有
- **致命错误打在 stdout 上、退出码 `-1`**（`Wsl/<CODE>`）—— 只看 stderr 会把
  「发行版不存在」误判成「成功但没有输出」
- **不要从退出码推断 ENOENT**：直接 `wsl -e <不存在的命令>` 给 **1**，
  经 `bash -lc` 给 **127**
- 用户数据**绝不拼进 shell 字符串**：用「常量脚本 + 位置参数」
  （`wsl -e sh -c '<常量脚本>' sh "$1"`），`wsl.exe -e` 传 argv 是逐字的

### 4.9 Docker：Engine API 的几个坑

**不要 shell 出 `docker.exe`** —— CLI 不保证存在。Node 内置 `http` 能直连命名管道
（`socketPath: '\\\\.\\pipe\\dockerDesktopLinuxEngine'`），零依赖就够。

- **文件内容走 `archive` 端点**（tar），**元数据走 exec**：
  archive 不依赖容器里的任何工具，distroless 里也能读写文件。
- **archive 对符号链接返回链接本身，不跟随** → 读符号链接会拿到空字符串。
  必须先 `realpath` 再重取，并给嵌套深度上限防成环。
- **`mode` 是 Go 的 `os.FileMode`，不是 POSIX `st_mode`**：目录 bit31、符号链接 bit27。
  当成 `st_mode` 会把目录认成普通文件。
- **多路复用流的 `streamType` 有 4 种**：0 stdin / 1 stdout / 2 stderr / **3 Systemerr**。
  第 3 种是守护进程自己的错误，必须浮出来（`docker-modem` 漏了这类）。
- **`ExitCode ?? 0` 会把失败报成成功**：必须 `Running === false` **且** ExitCode 非 null。
- **`Accept-Encoding: gzip` 会让守护进程压 tar** —— 我们从不设这个头。
- **archive 响应体不排空会占住容器锁** —— 总是完整读完。
- **取消不是 `docker kill`**（那会杀掉用户的整个容器）—— 取消是销毁 start 连接。

### 4.10 写脚本给容器执行：`exit` 会截断追加的 heredoc

一个实测踩到的坑：想把内容传给容器里的脚本时，**不能**写成
「常量脚本 + `\n` + heredoc」—— 脚本末尾的 `exit 0` 会**先结束 shell**，
heredoc 根本不执行。结果是**文件建出来了但是空的**，看起来像写成功。

内容必须**内联在同一个脚本里**。测试里有一条专门盯这个（断言 heredoc 在 `exit` 之前）。

### 4.11 容器里可能没有 `bash`，也没有 coreutils

**实测**（`alpine:3.20`）：

- **没有 `bash`** —— 只有 busybox 的 `sh`
- **busybox 的 `find` 没有 `-printf`**：`find: unrecognized: -printf`
- **busybox 的 `stat` 没有 `--printf`**（`-c` 有，格式串与 coreutils 一致）
- `base64 -w0` 在 busybox 上**能用**

所以：

- 探测到没有 `bash` 就退化到 `sh`；**连 `sh` 都没有**（distroless / scratch）
  就明确报错，并说明**文件内容读写仍然可用**（走 archive，不依赖容器工具）
- 列目录用 **busybox / coreutils 双兼容**的写法：

```sh
find -- "$d" -mindepth 1 -maxdepth 1 -exec sh -c '
  for f in "$@"; do
    stat -c "%n|%F|%s|%Y|%a" -- "$f" 2>/dev/null | tr "\n" "\0"
  done
' sh {} +
```

`find -exec ... +` 两种实现都支持，**一次 exec 拿全**；`tr '\n' '\0'` 让文件名里的
空格/换行都不破坏解析。

### 4.12 容器「没在运行」不等于「不能用」

**实测**：`archive` 端点对**已停止**的容器照样可用（`HEAD` 给元数据、`GET` 给 tar），
而 `exec` 不行。所以不要「容器没在运行就拒绝连接」—— 那会白白丢掉一个真实可用的能力。

正确做法：允许连接，但**把两种失败分开报**，因为修法完全不同：

| 情况 | 报什么 | 用户该做什么 |
|---|---|---|
| 容器没在运行 | 「没有在运行，无法执行命令」+ 说明文件内容仍可读写 | `docker start` |
| 容器在跑但没 shell | 「没有可用的 shell」+ 说明文件内容仍可读写 | 换镜像，或只用文件读写 |

混成一句「操作失败」，用户不知道该干什么。

### 4.13 单个 argv 参数上限是 128 KiB（不是 `ARG_MAX`）

**这条最坑**。Linux 的**单个参数**上限是 `MAX_ARG_STRLEN` = **131 072 字节**
（32 × PAGE_SIZE），与 `ARG_MAX`（2 MiB）**毫无关系**。超了内核直接 `E2BIG`，
容器里看到的是：

```
exec /usr/bin/bash: argument list too long
```

实测：单个参数 **131 071 OK / 131 072 失败**。

推论：**任何把内容放进命令行的写法都有这个天花板** —— heredoc、base64、
`printf '%s'` 全都一样。文件内容必须走**请求体**（Docker 走 `archive` 端点的 tar）。

> 反面教材：早期实现把 base64 内联进 `bash -c <script>`，原子写路径最大只能到
> 98 217 字节；再往上就落到不原子的兜底，64 MiB 时甚至把 dockerd OOM 杀掉。

### 4.14 Docker 的 `exec/start` **收不到 stdin**

想把内容经 stdin 喂给容器里的进程（`base64 -d > tmp`）？在这个守护进程上**做不到**。
三种写法实测全部失败：

| 写法 | 结果 |
|---|---|
| chunked 请求体（JSON + stdin 一起流式发） | `400 {"message":"unexpected content after JSON"}` |
| 声明 `Content-Length` 只覆盖 JSON，再写 stdin | **死锁**（守护进程等 body 结束，我们等响应） |
| 加 `Connection: Upgrade` / `Upgrade: tcp` | 守护进程**零响应**直到超时 |

所以别在这上面花时间 —— 用 `archive` 端点的 PUT（内容是 tar 请求体）。

### 4.15 写文件要原子，临时文件必须与目标**同目录**

`rename(2)` 只在**同一文件系统内**保证原子。把临时文件放 `/tmp` 而目标在别的挂载点，
`mv` 会悄悄退化成「复制 + 删除」—— 就不原子了。

正确做法：临时文件放目标目录里（`.dsh-mr.<随机>.tmp`），再 `mv -f` 替换。
失败时记得清掉临时文件（实测不清会一直攒：15 分钟 31 个）。

### 4.16 终端的信号走 PTY 控制字符，不要去 kill pid

要给终端里的前台命令发 `SIGINT`？**往 PTY 里写 `\x03`**，别去找 pgid 再 `kill`：

- PTY 的行规程会把 Ctrl-C 变成发给**前台进程组**的信号 —— 这正是终端语义
- 自己去 kill 不可靠：容器里未必有 `ps`，而且容易杀错组

| 信号 | 控制字符 |
|---|---|
| `SIGINT` | `\x03` |
| `SIGTSTP` | `\x1a` |
| `SIGQUIT` | `\x1c` |

### 4.17 `ctx.terminals` 在根上下文**不存在**

宿主把 `terminals` 隔离在它自己的 `persistent-shell` 组里（见内置 `minimal` 预设）。
所以：

- 插件顶层写 `inject: ['terminals']` 会**一直 pending**，插件永不激活
- 预设必须自己 `isolate: { terminals: true }` 并挂 `@deepseek-ai/dsh-terminal`，
  否则域内没有这个服务

另外：`ctx.terminals.registerBackend` 把后端存进**服务级**的 Map，
同名会抛 `DUPLICATE_BACKEND` —— 官方本地 shell 后端占用了 `shell`，所以要用别的名字。

### 4.18 工具的 `output` 必须是 `{ schema, render }`

给裸 JSON schema 会被拒：

```
unsupported JSON schema: schema must be a value schema object
```

而且这条错误会让**整个预设激活失败**（诊断标成 `broken`）、会话因此拒绝连接 ——
失败得很响亮（好事），但排查起来绕。`src/index.js` 里的 `textOutput()` 是正确形态的参考。

### 4.19 容器的读没有大小上限，写有

- **读**（`archive` GET）：实测到 64 MiB 逐字节一致，约 149–167 MiB/s，线性。
- **写**（`archive` PUT + `mv`）：实测到 **64 MiB** 正常（约 12.7 MiB/s）。
  （旧实现在这个档位会 67 秒超时并把 dockerd OOM 杀掉，新实现 5.0 秒完成。）

`readFile` 的默认 `maxBytes` 是 32 MiB，且是**硬上限**（超过报 `TOO_LARGE`，不截断）。
一个已知特点：它会在**下载完之后**才报错。要避免浪费传输可以先用 `HEAD archive` 预检大小。

### 4.20 Docker 的守护进程端点要按平台解析

`http.request` 的 `socketPath` 在两类平台上取值**完全不同**：

| 平台 | 端点 |
|---|---|
| Windows | 命名管道 `\\.\pipe\dockerDesktopLinuxEngine`（退 `\\.\pipe\docker_engine`） |
| 类 Unix | `/var/run/docker.sock`（退 `/run/docker.sock`） |

写死命名管道的话，macOS / Linux 上 Docker 后端**完全不可用**。
`DOCKER_HOST` 显式给出时优先（支持 `npipe://` 与 `unix://`）；
**`tcp://` 与 `ssh://` 要明确报「不支持」** —— 静默退到默认端点会报一个笼统的
「连不上」，用户去查 Docker Desktop，而问题其实在 `DOCKER_HOST`。

### 4.21 想验 SSH 但手头没有靶机？自己造一个

SSH 后端和它的交互式终端都可以用**容器里跑 sshd** 来验，不需要外部服务器：

```dockerfile
FROM alpine:3.20
RUN apk add --no-cache openssh util-linux bash && \
    adduser -D -s /bin/bash tester && \
    echo 'tester:dshmrtest' | chpasswd && \
    mkdir -p /home/tester/.ssh && \
    echo '<你的公钥>' > /home/tester/.ssh/authorized_keys && \
    chmod 700 /home/tester/.ssh && chmod 600 /home/tester/.ssh/authorized_keys && \
    chown -R tester:tester /home/tester/.ssh && \
    ssh-keygen -A
EXPOSE 22
CMD ["sh", "-c", "mkdir -p /run/sshd && exec /usr/sbin/sshd -D -e"]
```

```bash
docker build -t dsh-mr-sshd .
docker run -d --name dsh-mr-sshd -p 2222:22 dsh-mr-sshd

DSH_MR_SSH_TEST=1 DSH_MR_SSH_HOST=127.0.0.1 DSH_MR_SSH_PORT=2222 \
DSH_MR_SSH_USER=tester DSH_MR_SSH_KEY=<私钥路径> \
DSH_MR_SSH_SANDBOX=/tmp/dsh-mr-ssh-e2e node --test
```

**两个会让这件事卡很久的坑**（都不是本插件的问题，但值得写下来）：

1. **`ssh-keygen -N '""'` 生成的是「口令为两个引号字符」的密钥**，不是空口令。
   症状很误导：服务端日志显示 `matching key found`，但认证仍然失败
   （因为客户端拿不出口令去签名）。正确写法是 `-N ''`。
2. **容器里的 `/run` 是 tmpfs** —— 镜像里 `mkdir /run/sshd` 在启动后就没了，
   sshd 的 privsep 子进程起不来。要在 `CMD` 里再建一次。

### 4.21b 拿**真机器**当靶机时要注意什么

容器夹具验证不了这些 —— 它们只在真机上出现，而且**实测抓到过一个真 bug**：

| 真机才有 | 夹具为什么测不出 | 后果 |
|---|---|---|
| **登录 banner**（motd / 未读邮件 / 「需要重启系统」） | 容器没有 motd、没有 rc 文件 | 开终端后立刻发命令，命令输出会被 banner 的间隙吞掉 |
| **中文 / 宽字符** | 夹具里全是 ASCII | 终端**折行**把短字符串切断，跨行正则匹配失败 |
| **上次运行的残留文件** | 每次都是新容器，沙箱天然是空的 | 「清理沙箱」写错了也看不出来 |
| **发行版会自己停、`/tmp` 会被清空**（见下） | 容器一直活着 | 沙箱文件**中途消失**，验证结论变得不可信 |

> ⚠️ **在 WSL 上别用 `/tmp` 当沙箱**（2026-10-07 实测，排查了很久）：
> Ubuntu 的 `/usr/lib/tmpfiles.d/tmp.conf` 里是
> `D /tmp 1777 root root 30d` —— **`D` 的意思是「启动时清空该目录」**，
> 与文件新旧无关。而 WSL 发行版**空闲约 20 秒就自动停**，
> 所以下一次调用等于一次重启，`/tmp` 里的东西就没了。
>
> 症状极具误导性：写进去明明成功，过一会儿去核查却「文件不存在」，
> 让人以为是写入落到了别处。**用家目录（`$HOME/...`）当沙箱就不会有这个问题。**
> 这个坑也解释了为什么早先几次真机核对会时好时坏。

> 上表第一行就是实测抓到的**产品 bug**：现在首次发送前会先等 banner 打完
> （见 [CHANGELOG](CHANGELOG.md)）。第二、三行是**测试**自己的 bug ——
> 一个把通配符也引号包住了（`rm -rf '/tmp/x/*'` → 什么都没删），
> 一个跨行匹配。

**给靶机做清理时的硬规矩**：端到端测试要在**别人的真机器**上 `rm -rf`，
所以先断言路径长得像专用沙箱（在 `/tmp/` 下、不是 `/tmp/` 本身）：

```js
function isSafeSandbox(path) {
  const normalized = String(path).replace(/\/+$/, '')
  return normalized.startsWith('/tmp/') && normalized.length > '/tmp/'.length
}
```

`DSH_MR_SSH_SANDBOX=/` 一个手误就能删根目录 —— **测试代码写对了不够，要挡住手误**。

### 4.22 发布前：用**干净 profile** 验一遍安装

自己天天用的 profile 是脏的（早就有 `node_modules`、早就登记过 bundle），
所以「在我机器上能跑」证明不了陌生人能装上。发布前照这个走一遍：

```bash
# 1) 建一个全新 profile（DSH_HOME 指向临时目录，别碰你自己的）
export DSH_HOME=/tmp/dsh-clean
dsh --profile releasetest --from-default-profile web --dump-config

# 2) 用自带安装器装（它会在最后**回读校验** bundle 真的被登记）
node scripts/install.mjs --profile releasetest --dsh-home "$DSH_HOME"

# 3) 起起来看有没有 warning，然后打自检
dsh --profile releasetest --no-open --port 19389
curl "http://127.0.0.1:19389/multi-remote/selfcheck?token=<token>"
```

期望：启动**没有任何 warning**，自检里 `ok: true`、5 个工具全部
`registered && visibleToModel`、四条路由都能通、`backends` 三种都报出状态。

> `--dry-run` 可以先看安装器打算改哪些文件（它会打印将写入的
> `pnpm-workspace.yaml` 与将执行的 `dsh plugin` 命令）。

### 4.23 测完就清理你创建的容器与镜像

**开发期不要假设「跑着的 Docker 不会被升级」。** Docker Desktop 会在后台**自动更新**并
重启引擎；实测遇到过：更新过程中后端被强杀，重启后**引擎换了一块数据盘**，
原来的容器与镜像全部看不见了（`docker ps -a` 与 `docker images` 双空）。

这不只是整洁问题 —— **别让别人的环境承担你的实验成本**：

```bash
docker rm -f <你创建的容器>
docker rmi <你拉取的镜像>
```

顺便：如果你在跑真机端到端测试，**测完请把 `DSH_MR_DOCKER_CONTAINER` 指的容器删掉**，
不要留在那里。

> 排查这类问题可以看 Docker 自己的日志（都是纯文本，比猜快得多）：
> - `%LOCALAPPDATA%\Docker\log\host\Docker Desktop Updater-*.log` —— 自动更新记录
> - `%LOCALAPPDATA%\Docker\log\host\Docker Desktop.exe.log` —— 后端退出码
> - 在 `docker-desktop` 发行版里 `mount | grep '^/dev/'` —— 数据盘到底挂没挂

### 4.24 想在进程内起一个真 SSH 服务端？

`ssh2` 自带 `Server`，所以**不需要靶机、不需要网络、不需要 Docker**
就能测完整的握手 + 认证 + 断线链路：

```js
import ssh2 from 'ssh2'
const { Server, utils } = ssh2

const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
  client.on('authentication', (auth) => auth.accept())          // 测试用：一律放行
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec()
        stream.write(`RAN:${info.command}\n`)
        stream.exit(0)
        stream.end()
      })
    })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))   // 端口 0 = 系统分配
```

用它的测试跑在**默认测试集**里（不像「容器里跑 sshd」那组要跳过），
所以「SSH 断线重连」这种逻辑每次 CI 都会验。见
`test/transport-ssh-live-reconnect.test.mjs`。

**两个必踩的坑：**

1. **`server.close()` 会挂住**。它只停止接受**新**连接，然后**等已有连接结束** ——
   客户端还连着就永远不回调（测试直接挂死）。要先主动断开：
   ```js
   server.close(() => resolve())
   for (const client of liveClients) client.end()
   ```
2. **`server.on('connection')` 给的是 ssh2 的 `Client`，不是裸 socket** ——
   没有 `destroy()`，用 `client.end()`。

> 另外：`SshTransport` 的 `onHostKey` 是**通知回调**，不是「信任决定」。
> 它的存在让未知密钥走 TOFU（自动记住）；**不给它**、又没预置 `known_hosts` 时
> 会**拒绝连接** —— 那是刻意的「宁可拒绝也不静默接受陌生密钥」。

### 4.25 想给客户端加界面入口？**先读这次真机事故**

2026-10-07 我们把「远程开发」做在了侧边栏「工作区」旁 `+` 按钮的
**选目录流程**里 —— 查插槽树时看到 `sidebar.workspaces.directoryFlow`
是个可注册的单占位洞，契约也很干净：

```ts
interface DirectoryFlowOwnerProps {
  open: boolean
  busy: boolean
  onPicked: (path: string) => void
  onCancel: () => void
  onError: (message: string) => void
}
```

真机结果：**用户的 DSH 直接打不开了**。崩溃日志：

```
Error: web boot: 1 entry did not activate
@deepseek-ai/dsh-client-ui-directory-picker-native: failed
```

**原因**：那个洞**已经有官方归属** —— 桌面端的「打开文件夹」由官方插件
`@deepseek-ai/dsh-client-ui-directory-picker-native` 提供。
我们一注册，它激活就失败，**web boot 整个起不来**。

三条教训，每条都反直觉：

1. **`replaceRisk: shadows-shipped-ui` 的单占位洞不是空位，是有主的。**
   「可注册」不等于「给你用」。占用者之间会冲突。
2. **炸的是别人的激活，崩溃日志里报的是别人的名字**（不是我们的）。
   只看报错根本想不到是自己干的 —— 这种时候要问「我最近动了哪个共享资源」。
3. **测试全绿挡不住这种事**。我们的测试用的是假插槽环境，官方插件根本不在场。
   **动共享 UI 资源前，先想清楚「原占用者会发生什么」**。

所以现在的做法是**加法式**，用的是宿主自己的三个槽位：

| 槽位 | 类型 | 放什么 |
|---|---|---|
| `sidebar.panellist` | list（`replaceRisk: none`） | 侧边栏的一行导航（id 自己起） |
| `main` | keyed（keyDomain 开放） | 那一行对应的主区域格子 —— 只当**跳板**：开弹窗后立刻切回会话 |
| `shell.overlay` | list（`replaceRisk: none`，root 作用域） | **弹窗本体** —— 只有它能盖住整个框架（含侧边栏） |

前两个**必须共用同一个 id**（`id` ↔ `key`）—— 宿主就是靠它把「点哪一行」
和「主区域哪一格」配起来的；少注册 `main`，那一行点下去就是一片空白。
弹窗**不能**画在主区域里：那样会被关在中央区域、盖不住侧边栏，看起来就不像弹窗。
两棵互不相干的子树之间用一个**模块级订阅表**通信（`setDialogOpen`），
不必为这点事引状态库。

**图标由宿主画**：我们只交一个用 `currentColor` 描边的线框 SVG，
宿主把 `{ size, active }` 传进来，所以选中态、配色、留白和官方那几项完全一致。

客户端注册它时同样要**同步**（写在 `apply()` 体内，不能进
`fetch().then()` —— 异步回调不在生效作用域内，注册会**静默失效**，
症状是「界面还是官方行为」，插槽占用者查出来还是官方的，毫无报错）。

#### 第三个「测试全绿挡不住」：**渲染期**才炸

2026-10-09：弹窗第一帧读了一个 `null` 的属性（`wslInfo.systemDistros` ——
可选项还没从宿主返回时它就是 `null`）。渲染期抛错 → 错误边界把整个弹窗
换成了一块错误面板，用户看到的是「**远程开发打不开，显示出错了**」。

**为什么前面所有闸门都没拦住**：

| 闸门 | 为什么没拦住 |
|---|---|
| 静态检查（`client-contract.test.mjs`） | 它只匹配字符串 / 结构，读 `null` 的属性是**运行时**的事 |
| `client-half.test.mjs` 的既有测试 | 它们只调 `apply(ctx)` 检查**注册**，从不**渲染** |
| `node --check` / 语法 | 语法完全合法 |

**现在有闸门了**：`test/client-half.test.mjs` 里有一个**极简渲染器**
（`renderTree`）—— 它把元素树真的走一遍，真的调用函数组件与类组件
（连 `this.props.children` 的类组件传参都照真 React 来）。
第一条用它写的测试是「弹窗第一帧就能渲染」，并且用**负对照**验证过：
把守卫去掉它立刻变红。

> **局限（写清楚，免得误以为它万能）**：替身的 hooks 不支持状态更新，
> 所以它只覆盖**第一帧**。要覆盖交互（点一下切到 Docker 面板、筛选项生效）
> 需要真的 React 测试环境 —— 那是以后的事。

**写渲染路径的规矩**：任何 `xxx.yyy` 之前先问一句「`xxx` 可能是 `null` 吗」——
尤其 `options` / `targets` / `wslInfo` / `dockerInfo` 这种**异步来的**数据。
宿主少给一个字段不该让整个界面变成一块错误面板。

#### 另一个静默 bug：编造的 CSS 变量名

客户端里一直写着 `var(--dsh-border, …)` / `var(--dsh-accent, …)` / `var(--dsh-surface, …)` ——
这些变量**在当前 DSH 里根本不存在**（真实的是 `--dsw-alias-*`）。后果是**没有任何报错**：
每个样式都静默地吃兜底色，看起来「能用」，但换主题、切浅色都跟不上，
一眼就不像 DSH 自己的界面。**这个 bug 活了很久**，因为兜底色恰好都是中性灰。

**教训**：主题变量名不要猜。宿主提供了 `cordis_inspect` 的 `Theme.listTokens`，
一次调用就能拿到全部 token 名与用途 —— **写 UI 之前先查**。
现在用的那几个：`--dsw-alias-bg-layer-1/2`、`-border-l1/l2`、`-label-primary/secondary`、
`-brand-primary`、`-state-error-primary`。

客户端与宿主之间走 **HTTP 路由**（`fetch('/multi-remote/...')`）。
客户端内置的 `host.call` 是「包私有 RPC」，但宿主侧怎么注册它没有公开约定 ——
实测第三方客户端插件（`dsh-better-sidebar`）用的也是 HTTP 路由。
请求校验在宿主侧（`src/http/ui-routes.js`）：**严格白名单**，凭据**绝不回显**。

另外值得抄走的调试手段：**客户端自诊断上报**。客户端跑在浏览器里，
出问题时我们看不到它的控制台 —— 让它把每一步 POST 回
`/multi-remote/client-report` 写进审计日志，「点了没反应」这种问题
从服务端就能定位，不用猜。

### 4.26 WSL 发行版不一定是 GNU：busybox 的三条坑（实测）

Docker Desktop 的 `docker-desktop` 发行版是 **busybox**（BusyBox v1.37），
Alpine-on-WSL 也是。拿它当目标时实测踩到三条：

| 坑 | 现象 | 解法 |
|---|---|---|
| **没有 `bash`** | `execvpe(bash) failed: No such file or directory` | 连接时探测一次：优先 `bash -lc`，没有就 `sh -c` —— **POSIX shell 才是硬要求** |
| **`find` 没有 `-printf`** | `find: unrecognized: -printf` | 退到 `find -exec sh -c '…stat -c…' sh {} +`，**字段顺序与 GNU 路保持一致**（解析器不用改） |
| **`stat -c` 不解释 `\0`** | `-c '%F\0%s'` 输出的是**字面的 `\0` 两个字符** —— busybox 与 GNU **都**这样，只有 `--printf` 才解释 | busybox 退路的 NUL 由 `printf '%s\0'` 产出（实测两个实现都认） |

**探测 shell 时的两条硬约束**（都是被测试抓出来的，不是我事先想到的）：

1. **必须占并发槽位 + 单飞**：否则 16 路并发会冒出 16 个 `wsl.exe`，
   而**并发上限 4 是实测底线**（8 路以上会把 relay 打到 30 秒级停顿）。
2. **致命错误与超时照旧上抛**：`Wsl/E_DISTRO_NOT_FOUND` 说的是「发行版不存在」，
   **不是**「这个 shell 没有」；把超时说成「没有 shell」就是**谎报原因**。

> **验证方式**：`wsl -d docker-desktop`（busybox）与 `wsl -d Ubuntu-24.04`（GNU）
> **各跑一遍**列目录 —— 两条路都要过。只测 Ubuntu 会漏掉整条 busybox 退路。

### 4.27 想给插件加「设置项」？走宿主的 `configEditor`（附 Entry 形状的坑）

**别自己写配置文件。** 宿主有 `configEditor`（软取：`ctx.get('configEditor')`）：

| 方法 | 用途 |
|---|---|
| `entries()` | 可寻址的 profile 行 |
| `configuration()` | 读继承值 + 显式覆盖值 |
| `edit(entry, change)` | **校验 + 持久化 + 走正常 Loader 路径重新应用**（插件会重载） |

**⚠️ `Entry` 的形状别猜**（2026-10-09 实测）：

```js
{ id: 'include:multi-remote', name: null, patchId: null,
  options: { name: '@jk-uzi/dsh-multi-remote' }, /* loader, ctx, fiber, parent, … */ }
```

包名在 **`entry.options.name`** 里；`entry.name` 与 `entry.patchId` 都是 `null`。
按 `entry.name` 找会**永远找不到** —— 症状是用户点保存得到「找不到本插件那一行」。
**拿不准就先 dump 一次**（`entries().map(e => Object.keys(e))`），别照名字猜。

两条产品约束：

1. **保存 = 插件重载** → 界面上必须明说「已连接的远程工作区会断开，重连一次即可」。
2. **服务可能不在场** → 写进 `inject` 会让没有它的 profile **整个插件挂不上**；
   所以用 `ctx.get()` 软取，取不到就**如实说改不了**并给手工办法，**不假装有开关**。

> 落点说明：`edit()` 会往 profile 的 `cordis.patch.yml` 写一条
> `- id: <你的行 id>` + `config: {...}` 的**定向覆盖**（patch 文件头部那套机制）。
> 所以你的行 id 必须**全局唯一**且稳定。

### 4.28 Windows 上别用 PowerShell 的 `Set-Content` / `Add-Content` 改仓库文件

`.gitattributes` 规定全仓库 **LF**（本插件没有构建步骤，宿主直接加载 `src/*.js`；
目标环境一律 POSIX shell，CRLF 会让脚本跑不起来、diff 全是噪音）。
而在 Windows 上，PowerShell 的 `Set-Content` / `Add-Content` **默认写 CRLF**
（`Out-File` 还可能带 BOM）—— `.gitattributes` 只管入库时的归一化，
**拦不住工作区里已经写坏的文件**。

这个仓库**实测踩到两次**（2026-10-09：`CONTRIBUTING.md` 重排章节、`.gitignore` 追加一行），
症状是 `git diff` 报 `CRLF will be replaced by LF`，且整文件的行尾全变。

**正确写法**（LF、无 BOM，二者都显式）：

```powershell
[System.IO.File]::WriteAllText($path, ($text -replace "`r`n", "`n"),
  (New-Object System.Text.UTF8Encoding($false)))
```

提交前自查一次：

```powershell
# 有输出 = 有 CRLF 残留
git ls-files | ForEach-Object {
  if ((Get-Content $_ -Raw) -match "`r") { "CRLF: $_" }
}
```

> 更省心的办法：改文件用编辑器或 `git add --renormalize .`，
> 把 PowerShell 只留给「跑命令」，不用来「写文件」。

## 5. 代码约定

- **零运行时 npm 依赖**是目标。确需引入依赖时，请在 PR 描述里说明理由。
- 平台：Windows 优先（WSL 档依赖），macOS / Linux 上 SSH + Docker 可用。
- 目标环境一律要求 **POSIX shell**；原生 Windows 远端（WinRM / SSH→Windows）不在范围内。
- 安全红线（评审会重点看）：
  - 路径围栏判定必须发生在 **`realpath` 之后**，防符号链接逃逸；拒绝时用 `FS_SANDBOX_DENIED`。
  - 凭据不落明文、不回显，凭据文件权限 `0600`。
    **什么算凭据**：私钥**内容**、口令、passphrase、agent socket —— 这四样永不落盘、永不回显。
    **私钥「路径」不算**（`~/.ssh/id_ed25519` 认证不了任何人），它落盘、也回显给界面 ——
    因为「用过的连接」正是靠它才能一键填好，否则用户每次都要重敲一遍。
    这条边界由测试钉住（`SENSITIVE_FIELDS` + `describeProfiles` 的白名单断言），
    **要加新的认证相关字段，先想清楚它是不是凭据**。
  - 破坏性操作（删除、停止容器等）必须显式确认。
  - **不谎报沙箱事实**：远端命令不受本地沙箱约束时，要在提示里说明边界是目标账号自身权限。
- 提交信息：`type(scope): 摘要`
  - `type ∈ {feat, fix, docs, chore, refactor, test, spike}`
  - `scope ∈ {fs, shell, ssh, wsl, docker, tools, ui, docs, repo}`
  - 例：`feat(ssh): 用 ssh2 实现 Transport.readFile`

## 6. 提 PR

1. 先开 Issue 描述你要做什么（大改动请先讨论方案，避免白做）。
2. Fork → 分支开发 → 保持提交聚焦，一次提交只做一件事。
3. PR 描述里写清：**改了什么、怎么验证的、有什么已知限制**。
4. 涉及新功能时，请附上可复现的验证步骤（命令 + 期望输出）。

## 7. 许可证

贡献的代码按 [MIT](LICENSE) 授权。

