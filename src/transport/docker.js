/**
 * Docker transport —— 通过 **Docker Engine API** 驱动一个**已在运行**的容器。
 *
 * ## 为什么不 shell 出 `docker.exe`
 *
 * `docker` CLI 不保证存在（只有 daemon 在跑、或用的是别的客户端）。而 Engine API
 * 只要 daemon 可达就行。实测 **Node 内置 `http` 能直连命名管道**：
 *
 * ```js
 * http.request({ socketPath: '\\\\.\\pipe\\dockerDesktopLinuxEngine', path: '/version' })
 * ```
 *
 * 所以**零 npm 依赖**就能做到，不必引入 `dockerode`（项目硬约束：只允许 `ssh2`）。
 *
 * ## 文件内容走 archive 端点，元数据走 exec（D-021）
 *
 * | 操作 | 走哪条 | 为什么 |
 * |---|---|---|
 * | 读/写文件**内容** | `GET/PUT /containers/{id}/archive`（tar） | **不依赖容器里的任何工具** —— distroless / scratch 里也能用；二进制安全 |
 * | **元数据**（stat / readdir） | exec | tar 头信息有限，拿不到完整的权限与符号链接语义 |
 * | **原子写** | exec（`mktemp` + `mv -f`） | archive 没有「原子替换」原语 |
 *
 * ## 范围（已定 D-004）
 *
 * **只连已运行的容器**，绝不创建 / 启动。找不到或没在跑就明确报错。
 *
 * ## 实测细节（以下每条都真机验证过）
 *
 * - exec 响应是**多路复用流**：8 字节头 = `streamType(1) + 000(3) + size(4, 大端)`；
 *   **1 = stdout、2 = stderr**。两路的**顺序不保证**按写入顺序，所以要分开收集。
 * - 退出码在 `GET /exec/{id}/json` 的 `ExitCode`（要等 `Running: false`）。
 * - `WorkingDir` / `Env` 是**追加**，不是替换整个环境。
 */
import http from 'node:http'
import net from 'node:net'

import { Transport, TRANSPORT_ERROR, TransportError } from './transport.js'
import { buildTar, extractSingleEntry, TAR_TYPE } from './tar.js'
import { shellQuote } from '../terminal/quote.js'

/** 默认管道：Docker Desktop 的 Linux 引擎（仅 Windows）。 */
export const DEFAULT_PIPE = '\\\\.\\pipe\\dockerDesktopLinuxEngine'

/** 经典守护进程管道（Docker CE / 旧版 Desktop，仅 Windows）。 */
export const LEGACY_PIPE = '\\\\.\\pipe\\docker_engine'

/** 类 Unix 上的默认 socket。 */
export const UNIX_SOCKET = '/var/run/docker.sock'

/** 容器内（DooD / 挂载了 socket）常见的备用位置。 */
export const UNIX_SOCKET_ALT = '/run/docker.sock'

/**
 * 按当前平台解析出**要依次尝试**的守护进程端点。
 *
 * ## 为什么不能只写死 Windows 命名管道
 *
 * `http.request({ socketPath })` 在两类平台上的取值完全不同：
 *   - Windows：命名管道（`\\.\pipe\...`）
 *   - 类 Unix：UNIX domain socket（`/var/run/docker.sock`）
 *
 * 写死命名管道的话，macOS / Linux 上 Docker 后端**完全不可用**
 * （而 SSH 与 WSL 各自的情况不同：SSH 全平台可用，WSL 只有 Windows 有）。
 *
 * `DOCKER_HOST` 显式给出时优先用它 —— 用户比我们更清楚守护进程在哪。
 * 只处理 `npipe://` 与 `unix://`；`tcp://` / `ssh://` 不在支持范围（要 TLS / 额外协议）。
 *
 * @param {{ env?: Record<string,string|undefined>, platform?: string }} [options]
 * @returns {{ endpoints: string[], source: string, unsupported?: string }}
 */
export function resolveDockerEndpoints(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const host = typeof env.DOCKER_HOST === 'string' ? env.DOCKER_HOST.trim() : ''

  if (host !== '') {
    if (host.startsWith('npipe://')) {
      // npipe:////./pipe/docker_engine → \\.\pipe\docker_engine
      const rest = host.slice('npipe://'.length)
      const pipe = rest.startsWith('//./pipe/')
        ? `\\\\.\\pipe\\${rest.slice('//./pipe/'.length)}`
        : rest
      return { endpoints: [pipe], source: 'DOCKER_HOST(npipe)' }
    }
    if (host.startsWith('unix://')) {
      return { endpoints: [host.slice('unix://'.length) || UNIX_SOCKET], source: 'DOCKER_HOST(unix)' }
    }
    // tcp:// 与 ssh:// 需要 TLS / 额外协议栈 —— 明确不支持，不假装能连
    return {
      endpoints: [],
      source: 'DOCKER_HOST',
      unsupported:
        `DOCKER_HOST=${host} 不在支持范围。` +
        '本插件只支持本机守护进程（Windows 命名管道 / 类 Unix 的 unix socket）；' +
        'tcp:// 与 ssh:// 需要 TLS 与额外协议，未实现。',
    }
  }

  if (platform === 'win32') {
    // 两个管道在 Docker Desktop 上都在，语义不同，所以依次试
    return { endpoints: [DEFAULT_PIPE, LEGACY_PIPE], source: 'default(win32)' }
  }
  return { endpoints: [UNIX_SOCKET, UNIX_SOCKET_ALT], source: 'default(unix)' }
}

/** 单次 exec 的默认超时。 */
const DEFAULT_TIMEOUT_MS = 120_000

/** 文件操作的超时。 */
const FILE_TIMEOUT_MS = 60_000

/** 读文件的默认硬上限。 */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

/** 在容器内执行的**常量脚本**。用户数据一律经位置参数传入。 */
const SCRIPTS = {
  /** 规范绝对路径。 */
  realpath: `#!/bin/sh
p="$1"
if [ -e "$p" ]; then
  readlink -f -- "$p" 2>/dev/null || printf '%s' "$p"
  exit 0
fi
printf '%s' "$p"
exit 2
`,

  /** 元信息：类型 / 大小 / mtime（秒）/ 权限 / uid / gid（NUL 分隔）。 */
  statNul: `#!/bin/sh
p="$1"
if [ -L "$p" ] && [ ! -e "$p" ]; then
  printf 'symbolic link\\0%s\\0%s\\0%s\\0%s\\0%s\\0' 0 0 777 0 0
  exit 0
fi
[ -e "$p" ] || exit 2
exec stat -L --printf '%F\\0%s\\0%Y\\0%a\\0%u\\0%g\\0' -- "$p" 2>/dev/null || \\
  exec stat -L -c '%F\\0%s\\0%Y\\0%a\\0%u\\0%g\\0' -- "$p"
`,

  /**
   * 列一层目录。
   *
   * ⚠️ **不能用 `find -printf`** —— busybox 的 `find` 没有这个选项
   * （实测 alpine：`find: unrecognized: -printf`）。
   * 改用 `find -exec stat ... +`：两种实现都支持，而且是**一次 exec 拿全**。
   *
   * 输出用 **NUL 分隔**（`tr '\n' '\0'`），这样文件名里的空格/换行都不会破坏解析。
   */
  readdir: `#!/bin/sh
d="$1"
[ -d "$d" ] || exit 2
find -- "$d" -mindepth 1 -maxdepth 1 -exec sh -c '
  for f in "$@"; do
    stat -c "%n|%F|%s|%Y|%a" -- "$f" 2>/dev/null | tr "\\n" "\\0"
  done
' sh {} +
exit 0
`,

  /**
   * 第一步：在目标目录里开一个临时文件，把路径打印出来。
   *
   * 拆成两步（而不是一个脚本里 heredoc）是因为：临时文件名必须由**容器**决定
   * （要同目录、要唯一），而内容由宿主编码。分两步各自都简单、可测。
   */
  stageTemp: `#!/bin/sh
p="$1"
dir=$(dirname -- "$p")
tmp=$(mktemp "$dir/.dsh-mr.XXXXXX" 2>/dev/null) || tmp=$(mktemp "/tmp/.dsh-mr.XXXXXX") || exit 3
printf 'DSHMR-TMP:%s\\n' "$tmp"
`,

  /** 第二步：把内容写进临时文件，再原子替换目标（rename(2)）。 */
  commitTemp: `#!/bin/sh
tmp="$1"
p="$2"
if [ -e "$p" ]; then
  chmod --reference="$p" -- "$tmp" 2>/dev/null || true
fi
mv -f -- "$tmp" "$p" || exit 5
exit 0
`,

  /**
   * 把 base64 内容解码写进临时文件 —— **内容走 stdin**。
   *
   * ⚠️ 为什么不能把内容放进脚本里（heredoc 也不行）：
   * Linux 的**单个 argv 参数**上限是 `MAX_ARG_STRLEN` = **128 KiB**，
   * 与 `ARG_MAX`（2 MiB）无关。超了内核直接 `E2BIG`，容器里看到的是
   * `exec /usr/bin/sh: argument list too long`（退出码 255）。
   * 实测：64 KiB 的 base64（约 87 KB 文本）能过，128 KiB 就不行了。
   *
   * 所以脚本**只含固定文本**（路径经位置参数传），内容全部从 stdin 喂。
   */
  writeTempContent: `#!/bin/sh
tmp="$1"
[ -n "$tmp" ] || exit 3
base64 -d > "$tmp" 2>/dev/null || exit 4
exit 0
`,

  /** 探测 shell 与基本工具（连接时用）。 */
  probe: `#!/bin/sh
for t in sh stat find base64 mktemp mv readlink dirname; do
  command -v "$t" >/dev/null 2>&1 && printf '%s=1\\n' "$t" || printf '%s=0\\n' "$t"
done
printf 'bash=%s\\n' "$(command -v bash >/dev/null 2>&1 && echo 1 || echo 0)"
`,

  /** 把文件从暂存路径原子搬到目标（archive 兜底写法的第二步）。 */
  moveIntoPlace: `#!/bin/sh
src="$1"
dst="$2"
dir=$(dirname -- "$dst")
tmp=$(mktemp "$dir/.dsh-mr.XXXXXX" 2>/dev/null) || exit 3
cp -- "$src" "$tmp" 2>/dev/null || cat -- "$src" > "$tmp" || exit 4
mv -f -- "$tmp" "$dst" || exit 5
rm -f -- "$src" 2>/dev/null || true
exit 0
`,
}

/**
 * 极简 Docker Engine API 客户端。
 *
 * 只实现我们用到的那几个端点，**零依赖**。
 */
export class DockerClient {
  /**
   * @param {object} [options]
   * @param {string} [options.pipe] 命名管道（默认 Docker Desktop 的 Linux 引擎）
   * @param {number} [options.timeoutMs]
   */
  constructor(options = {}) {
    // 显式给 pipe 就用它；否则按平台解析（Windows 命名管道 / 类 Unix unix socket）。
    // `env` / `platform` 可注入，便于测试跨平台行为。
    const resolved = options.pipe === undefined ? resolveDockerEndpoints(options) : undefined
    this.endpoints = resolved?.endpoints ?? []
    this.endpointSource = resolved?.source ?? 'explicit'
    this.unsupportedEndpoint = resolved?.unsupported
    this.pipe = options.pipe ?? this.endpoints[0] ?? DEFAULT_PIPE
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    /** 协商出来的 API 版本前缀（如 `/v1.56`）；连接时确定。 */
    this.apiPrefix = ''
  }

  /**
   * 发一个请求。
   *
   * @param {string} path API 路径（不含版本前缀）
   * @param {{ method?: string, body?: Buffer|string, headers?: Record<string,string>,
   *           signal?: AbortSignal, timeoutMs?: number, raw?: boolean }} [options]
   * @returns {Promise<{ status: number, headers: object, body: Buffer }>}
   */
  request(path, options = {}) {
    const method = options.method ?? 'GET'
    const url = `${this.apiPrefix}${path}`
    const timeoutMs = options.timeoutMs ?? this.timeoutMs

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        options.signal?.removeEventListener?.('abort', onAbort)
        if (error !== undefined) reject(error)
        else resolve(value)
      }

      const req = http.request({
        socketPath: this.pipe,
        path: url,
        method,
        headers: { host: 'docker', ...options.headers },
      }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => finish(undefined, {
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }))
        res.on('error', (error) => finish(this.#wrap(error, path)))
      })

      const onAbort = () => {
        try {
          req.destroy()
        } catch {
          // 已经结束
        }
        finish(new TransportError(TRANSPORT_ERROR.ABORTED, 'Docker 请求已被取消', { operation: path }))
      }

      if (options.signal?.aborted === true) {
        onAbort()
        return
      }
      options.signal?.addEventListener?.('abort', onAbort, { once: true })

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => {
          try {
            req.destroy()
          } catch {
            // 已结束
          }
          finish(new TransportError(TRANSPORT_ERROR.TIMEOUT, `Docker 请求超时（${timeoutMs}ms）：${path}`, {
            operation: path,
          }))
        })
      }

      req.on('error', (error) => finish(this.#wrap(error, path)))
      if (options.body !== undefined) req.write(options.body)
      req.end()
    })
  }

  /** 把 Node 的网络错误归类。 */
  #wrap(error, path) {
    if (error instanceof TransportError) return error
    const code = String(error?.code ?? '')
    // 连不上：守护进程没在跑，或者管道名不对
    if (code === 'ENOENT' || code === 'ECONNREFUSED') {
      return new TransportError(
        TRANSPORT_ERROR.CONNECT_FAILED,
        `连不上 Docker 守护进程（${this.pipe}）。确认 Docker Desktop 已启动。`,
        { operation: path, target: this.pipe, retryable: true, cause: error },
      )
    }
    // ⚠️ 管道**曾经可用、现在断了** —— 典型场景是 Docker Desktop 引擎重启
    // （实测：自动更新会让引擎换一块数据盘并重启，此时旧管道上的请求全部失败）。
    // 这与「一直连不上」不同：重连一次通常就好了，所以单独归类，
    // 让上层能区分「要不要重试」。
    if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED') {
      return new TransportError(
        TRANSPORT_ERROR.CHANNEL_DEAD,
        `与 Docker 守护进程的连接断了（${code}）。Docker Desktop 可能重启过；` +
        '本插件会重连一次，仍然失败请确认它还在运行。',
        { operation: path, target: this.pipe, retryable: true, cause: error },
      )
    }
    return new TransportError(TRANSPORT_ERROR.UNKNOWN, `Docker 请求失败：${error?.message ?? error}`, {
      operation: path,
      target: this.pipe,
      cause: error,
    })
  }

  /**
   * 让缓存的握手结果失效 —— 下次请求会重新握手。
   *
   * 用途：管道断了之后（引擎重启），旧管道上拿到的 `apiPrefix` 不再可信。
   * 不清掉的话重连也会继续用旧前缀去连一个已经没了的管道。
   */
  invalidateHandshake() {
    this.apiPrefix = ''
  }

  /**
   * 把守护进程的 HTTP 错误响应转成**说得清**的 TransportError。
   *
   * ## 为什么需要
   *
   * 守护进程的错误体是 JSON：`{"message":"..."}`。直接把它塞进模板字符串会变成
   * `[object Object]`（实测踩到过 —— 真机重启引擎后报的是
   * `创建 exec 失败（HTTP 409）：[object Object]`，等于什么都没说）。
   *
   * ## 两个实测确认的状态码（对 `/containers/{id}/exec`）
   *
   * | 情况 | 状态码 | 守护进程的 message |
   * |---|---|---|
   * | 容器**存在但没在运行** | **409** | `container <id> is not running` |
   * | 容器**根本不存在** | **404** | `No such container: <id>` |
   *
   * 这两个要分开报，因为用户的动作完全不同：去 `docker start` vs 去检查容器名。
   *
   * @param {number} status
   * @param {Buffer|string} body
   * @param {string} operation
   * @param {string} target
   * @returns {TransportError}
   */
  static daemonError(status, body, operation, target) {
    // `body` 可能是原始 Buffer/字符串，也可能是 `json()` 已经解析好的对象
    let message
    if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body) && typeof body.message === 'string') {
      message = body.message
    } else {
      const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '')
      message = text.slice(0, 300)
      try {
        const parsed = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.message === 'string') {
          message = parsed.message
        }
      } catch {
        // 不是 JSON，保留原文
      }
    }

    if (status === 404) {
      return new TransportError(TRANSPORT_ERROR.NOT_FOUND, message, {
        operation,
        target,
        retryable: false,
      })
    }
    if (status === 409) {
      // 容器没在运行（最常见的原因：Docker 引擎重启过，容器被停了）
      return new TransportError(
        TRANSPORT_ERROR.CONNECT_FAILED,
        `${message}（容器没在运行。若是 Docker 刚重启过，容器会被停掉，需要 docker start）`,
        { operation, target, retryable: true },
      )
    }
    return new TransportError(TRANSPORT_ERROR.UNKNOWN, message, { operation, target })
  }

  /** 发一个 JSON 请求并解析响应。 */
  async json(path, options = {}) {
    const headers = { ...options.headers }
    let body = options.body
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body)
      headers['content-type'] = 'application/json'
    }
    const response = await this.request(path, { ...options, headers, body })
    const text = response.body.toString('utf8')
    let value
    try {
      value = text === '' ? undefined : JSON.parse(text)
    } catch {
      value = text
    }
    return { status: response.status, headers: response.headers, value }
  }

  /** 取 archive 路径的元数据（HEAD，无响应体）。 */
  headArchive(containerId, path, options = {}) {
    return this.request(`/containers/${encodeURIComponent(containerId)}/archive?path=${encodeURIComponent(path)}`, {
      ...options,
      method: 'HEAD',
    })
  }

  /**
   * 握手：取守护进程版本并定下 API 前缀。
   *
   * 会**依次试两个管道**：Docker Desktop 的 Linux 引擎优先，然后退回经典管道。
   * 两者在 Docker Desktop 上都在，但语义不同 —— 经典管道可能指向别的引擎，
   * 所以要顺带确认 `Os: 'linux'`。
   *
   * @returns {Promise<{ apiVersion: string, serverVersion: string, osType: string, pipe: string }>}
   */
  async handshake(options = {}) {
    // DOCKER_HOST 给了我们不支持的协议（tcp:// / ssh://）→ 立刻明确报错。
    // 不这样做的话会退到默认端点去试，最后报一个笼统的「连不上」，
    // 用户会去检查 Docker Desktop，而问题其实在 DOCKER_HOST。
    if (options.pipe === undefined && this.unsupportedEndpoint !== undefined) {
      throw new TransportError(TRANSPORT_ERROR.CONNECT_FAILED, this.unsupportedEndpoint, {
        operation: 'handshake',
        retryable: false,
      })
    }

    // 显式给了 pipe 就只试它；否则试平台解析出来的全部候选
    const candidates = options.pipe === undefined
      ? this.endpoints
      : [options.pipe]

    if (candidates.length === 0) {
      throw new TransportError(
        TRANSPORT_ERROR.CONNECT_FAILED,
        '没有可用的 Docker 守护进程端点',
        { operation: 'handshake', retryable: false },
      )
    }

    const failures = []
    for (const pipe of candidates) {
      const previous = this.pipe
      this.pipe = pipe
      try {
        const version = await this.json('/version', options)
        if (version.status !== 200) {
          failures.push(`${pipe}: HTTP ${version.status}`)
          this.pipe = previous
          continue
        }
        const apiVersion = version.value?.ApiVersion
        if (typeof apiVersion !== 'string' || apiVersion === '') {
          failures.push(`${pipe}: 没有报告 ApiVersion`)
          this.pipe = previous
          continue
        }
        this.apiPrefix = `/v${apiVersion}`
        return {
          apiVersion,
          serverVersion: String(version.value?.Version ?? ''),
          osType: String(version.value?.Os ?? ''),
          pipe,
        }
      } catch (error) {
        failures.push(`${pipe}: ${error?.message ?? error}`)
        this.pipe = previous
      }
    }

    throw new TransportError(
      TRANSPORT_ERROR.CONNECT_FAILED,
      `连不上 Docker 守护进程。试过：${failures.join('；')}。确认 Docker Desktop 已启动。`,
      { operation: 'handshake', target: candidates.join(', ') },
    )
  }

  /** 容器信息（不存在 / 未运行时明确报错）。 */
  async inspectContainer(id, options = {}) {
    const response = await this.json(`/containers/${encodeURIComponent(id)}/json`, options)
    if (response.status !== 200) {
      throw DockerClient.daemonError(response.status, response.value, 'inspectContainer', id)
    }
    return response.value
  }

  /** 列容器。 */
  async listContainers(options = {}) {
    const query = options.all === true ? '?all=1' : ''
    const response = await this.json(`/containers/json${query}`, options)
    if (response.status !== 200) {
      throw DockerClient.daemonError(response.status, response.value, 'listContainers', '')
    }
    return Array.isArray(response.value) ? response.value : []
  }

  /** 创建 exec。 */
  async createExec(containerId, spec, options = {}) {
    const response = await this.json(`/containers/${encodeURIComponent(containerId)}/exec`, {
      ...options,
      method: 'POST',
      body: spec,
    })
    if (response.status !== 201 && response.status !== 200) {
      // 404 = 容器不存在；409 = 容器没在运行（引擎重启后容器会被停掉）。
      // 两个都要分开报，而且**不能用 `String(value)`**（那会变成 `[object Object]`）。
      throw DockerClient.daemonError(response.status, response.value, 'createExec', containerId)
    }
    const id = response.value?.Id
    if (typeof id !== 'string' || id === '') {
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, '创建 exec 成功但没拿到 Id', { operation: 'createExec' })
    }
    return id
  }

  /** 启动 exec 并取回多路复用流。 */
  startExec(execId, options = {}) {
    // 需要喂 stdin 时走专门的实现（要边写边读，普通请求会把响应读完才返回）
    if (options.stdin !== undefined) return this.#startExecWithStdin(execId, options)
    return this.request(`/exec/${encodeURIComponent(execId)}/start`, {
      ...options,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify({ Detach: false, Tty: false }),
    })
  }

  /**
   * 启动 exec，**把 stdin 喂进去**，同时收响应。
   *
   * ## 为什么必须用裸 socket（踩过三次）
   *
   * Node 的 `http.request` 不支持「请求体半开」：`Content-Length` 一旦声明，
   * 写完就自动 `end()`，没法在 JSON 之后继续追加 stdin。实测的三种失败：
   *
   *   - 用 chunked → `HTTP 400 {"message":"unexpected content after JSON"}`
   *   - 声明 Content-Length 只覆盖 JSON，再写 stdin → **死锁**（守护进程等 body 结束）
   *   - 加了 `Connection: Upgrade` / `Upgrade: tcp` → **守护进程不回任何东西**，
   *     连接既不关也不响应，直到超时（实测：写 Upgrade 后 5 秒零响应；
   *     不写则立刻回 200 + 多路复用体 + 关闭连接）
   *
   * 所以正确的做法是：**自己写完整 HTTP 请求到裸 socket，但不带 Upgrade** ——
   * 请求头 + JSON + stdin 一次发完，然后等守护进程回 `200` 并把连接关掉。
   *
   * ⚠️ 这条路径存在的根本理由是内核限制：**单个 argv 参数上限 128 KiB**
   * （`MAX_ARG_STRLEN`），超过就是 `E2BIG` / `argument list too long`。
   * 所以大内容（文件正文）只能走 stdin。
   */
  #startExecWithStdin(execId, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const json = Buffer.from(JSON.stringify({ Detach: false, Tty: false }), 'utf8')
    const stdin = options.stdin

    const head = [
      `POST ${this.apiPrefix}/exec/${encodeURIComponent(execId)}/start HTTP/1.1`,
      'Host: docker',
      'Content-Type: application/json',
      `Content-Length: ${json.length}`,
      '',
      '',
    ].join('\r\n')

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        options.signal?.removeEventListener?.('abort', onAbort)
        if (error !== undefined) reject(error)
        else resolve(value)
      }

      const socket = net.connect(this.pipe)
      socket.setNoDelay?.(true)

      let buffer = Buffer.alloc(0)
      let headerEnd = -1
      let status = 0
      const bodyChunks = []

      const onAbort = () => {
        try {
          socket.destroy()
        } catch {
          // 已结束
        }
        finish(new TransportError(TRANSPORT_ERROR.ABORTED, 'exec 已被取消', { operation: 'startExec' }))
      }
      if (options.signal?.aborted === true) {
        onAbort()
        return
      }
      options.signal?.addEventListener?.('abort', onAbort, { once: true })

      socket.setTimeout(timeoutMs, () => {
        socket.destroy()
        finish(new TransportError(TRANSPORT_ERROR.TIMEOUT, `exec 超时（${timeoutMs}ms）`, {
          operation: 'startExec',
        }))
      })

      socket.on('error', (error) => finish(this.#wrap(error, 'startExec')))

      socket.on('data', (chunk) => {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
        if (headerEnd === -1) {
          headerEnd = buffer.indexOf('\r\n\r\n')
          if (headerEnd === -1) return
          const headerText = buffer.subarray(0, headerEnd).toString('latin1')
          status = Number.parseInt(headerText.split('\r\n')[0]?.split(' ')[1] ?? '0', 10)
          buffer = buffer.subarray(headerEnd + 4)
          if (status !== 200 && status !== 101) {
            finish(new TransportError(
              TRANSPORT_ERROR.UNKNOWN,
              DockerClient.daemonError(status, buffer, 'startExec', '').message,
              { operation: 'startExec' },
            ))
            socket.destroy()
            return
          }
        }
        if (buffer.length > 0) bodyChunks.push(buffer)
        buffer = Buffer.alloc(0)
      })

      // ⚠️ 用 `close` 而不是 `end` 结算：实测这个响应是 chunked 且没有结束标记，
      // `end` 可能永远不触发（守护进程把连接留到进程退出）。`close` 一定会来。
      socket.on('close', () => finish(undefined, {
        status,
        headers: {},
        body: Buffer.concat(bodyChunks),
      }))

      socket.on('connect', () => {
        // 一个 write 里把请求头 + JSON + stdin 全发出去：
        // 顺序与长度都严格符合 HTTP，守护进程就不会再等 body 了。
        socket.write(head, 'latin1')
        socket.write(json)
        socket.write(stdin)
      })
    })
  }

  /** 取 exec 的状态（含 ExitCode）。 */
  inspectExec(execId, options = {}) {
    return this.json(`/exec/${encodeURIComponent(execId)}/json`, options)
  }

  /** 改 TTY 窗口大小（只对 `Tty: true` 的 exec 有意义）。 */
  resizeExec(execId, cols, rows, options = {}) {
    return this.json(`/exec/${encodeURIComponent(execId)}/resize?h=${rows}&w=${cols}`, {
      ...options,
      method: 'POST',
    })
  }

  /**
   * 启动一个 **TTY** exec，并把 hijack 后的裸 socket 交出来。
   *
   * 与 {@link startExec} 的关键区别：
   *   - `Tty: true` → 输出是**裸流**（没有 8 字节多路复用头），而且 stderr 并进 stdout
   *   - 连接是 **hijack** 的：守护进程不会回一个普通的「读完就结束」的响应，
   *     而是一直挂着直到进程退出 —— 所以必须把 socket 交给调用方，不能等 `end`
   *
   * 实测：带 `Connection: Upgrade` / `Upgrade: tcp` 时守护进程回
   * `101 UPGRADED`，Node 走 `'upgrade'` 事件；不带时回 `200 OK` 走普通响应。
   * 两条路都要接住 —— 不同守护进程/代理行为不一致。
   *
   * @param {string} execId
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<import('node:net').Socket>}
   */
  startExecTty(execId, options = {}) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        options.signal?.removeEventListener?.('abort', onAbort)
        if (error !== undefined) reject(error)
        else resolve(value)
      }

      const req = http.request({
        socketPath: this.pipe,
        path: `${this.apiPrefix}/exec/${encodeURIComponent(execId)}/start`,
        method: 'POST',
        headers: {
          host: 'docker',
          'content-type': 'application/json',
          connection: 'Upgrade',
          upgrade: 'tcp',
        },
      })

      // 路 1：守护进程接受了 upgrade → Node 给一个裸 socket
      req.on('upgrade', (_res, socket) => finish(undefined, socket))

      // 路 2：守护进程没 upgrade，回了普通响应 → 响应流本身就是裸流
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => finish(new TransportError(
            TRANSPORT_ERROR.UNKNOWN,
            DockerClient.daemonError(res.statusCode, Buffer.concat(chunks), 'startExecTty', '').message,
            { operation: 'startExecTty' },
          )))
          return
        }
        finish(undefined, res)
      })

      const onAbort = () => {
        try {
          req.destroy()
        } catch {
          // 已结束
        }
        finish(new TransportError(TRANSPORT_ERROR.ABORTED, '开终端已被取消', { operation: 'startExecTty' }))
      }
      if (options.signal?.aborted === true) {
        onAbort()
        return
      }
      options.signal?.addEventListener?.('abort', onAbort, { once: true })

      req.on('error', (error) => finish(this.#wrap(error, 'startExecTty')))
      req.end(JSON.stringify({ Detach: false, Tty: true }))
    })
  }

  /** 取 archive（tar）。 */
  getArchive(containerId, path, options = {}) {
    return this.request(`/containers/${encodeURIComponent(containerId)}/archive?path=${encodeURIComponent(path)}`, options)
  }

  /** 上传 archive（tar）。 */
  putArchive(containerId, path, tar, options = {}) {
    return this.request(`/containers/${encodeURIComponent(containerId)}/archive?path=${encodeURIComponent(path)}`, {
      ...options,
      method: 'PUT',
      headers: { 'content-type': 'application/x-tar', ...options.headers },
      body: tar,
    })
  }
}

/**
 * 解析 Docker 的多路复用流。
 *
 * 8 字节头：`streamType(1) + 000(3) + size(4, 大端)`，之后跟 `size` 字节数据。
 * `streamType`：**0 = stdin、1 = stdout、2 = stderr、3 = Systemerr**。
 *
 * ⚠️ **3 是守护进程自己的错误流**，必须当成错误处理，不能当输出。
 * （`docker-modem` 就漏了这一类，导致守护进程的错误被静默吞掉。）
 *
 * @param {Buffer} buffer
 * @returns {Array<{ streamType: number, data: Buffer }>}
 */
export function parseMultiplexed(buffer) {
  const frames = []
  let offset = 0
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset]
    const size = buffer.readUInt32BE(offset + 4)
    if (offset + 8 + size > buffer.length) {
      // 流被截断：把剩下的当最后一段，而不是丢掉
      frames.push({ streamType, data: buffer.subarray(offset + 8) })
      break
    }
    frames.push({ streamType, data: buffer.subarray(offset + 8, offset + 8 + size) })
    offset += 8 + size
  }
  return frames
}

/** 从多路复用帧里取出三路内容。`systemerr` 是守护进程自己的错误。 */
export function collectFrames(frames) {
  let stdout = ''
  let stderr = ''
  let systemerr = ''
  for (const frame of frames) {
    const text = frame.data.toString('utf8')
    if (frame.streamType === 1) stdout += text
    else if (frame.streamType === 2) stderr += text
    else if (frame.streamType === 3) systemerr += text
  }
  return { stdout, stderr, systemerr }
}

/**
 * Docker transport。
 */
export class DockerTransport extends Transport {
  /**
   * @param {object} options
   * @param {string} options.container 容器名或 id（**必须已在运行**）
   * @param {string} [options.pipe] 命名管道
   * @param {DockerClient} [options.client] 注入客户端（测试用）
   * @param {(message: string, ...rest: unknown[]) => void} [options.log]
   */
  constructor(options) {
    super('docker')
    if (typeof options?.container !== 'string' || options.container.trim() === '') {
      throw new Error('DockerTransport 需要 container（容器名或 id）')
    }
    this.container = options.container.trim()
    this.client = options.client ?? new DockerClient({ pipe: options.pipe })
    this.log = options.log
    this.connected = false
    /** 容器信息（连接后填充）。 */
    this.containerInfo = undefined
    /** 能力探测结果：容器里有哪些工具。 */
    this.capabilities = undefined
    /** 重连过几次（诊断用；也便于测试断言）。 */
    this.reconnects = 0
  }

  /**
   * 跑一个操作；如果是**连接层失败**，重连一次再试。
   *
   * ## 为什么需要
   *
   * 实测（2026-10-07）：Docker Desktop **自动更新**会让引擎重启，旧命名管道随之失效。
   * 此后每个操作都失败，而错误信息看起来像「配置错了」—— 用户完全想不到
   * 「只是 Docker 重启过，重连一下就好」。
   *
   * 所以这里对**连接层**失败（`CONNECT_FAILED` / `CHANNEL_DEAD`）自动重连一次。
   *
   * ## 为什么只重试一次，且只对连接层失败
   *
   * - **只一次**：重连本身要握手（几十毫秒），无限重试会把一次失败拖成卡顿；
   *   而且守护进程真的没起来时，重试多少次都没用。
   * - **只对连接层**：`NOT_FOUND` / `PERMISSION_DENIED` / `TOO_LARGE` 这些是
   *   **操作的正常结果**，重试只会让同一个错误慢一倍出现。
   *
   * @template T
   * @param {string} operation 用于日志与错误归属
   * @param {() => Promise<T>} run
   * @returns {Promise<T>}
   */
  async #withReconnect(operation, run) {
    try {
      return await run()
    } catch (error) {
      const code = error?.code
      const isConnectionFailure = code === TRANSPORT_ERROR.CONNECT_FAILED || code === TRANSPORT_ERROR.CHANNEL_DEAD
      if (!isConnectionFailure) throw error

      // ⚠️ 有些 CONNECT_FAILED **重连也没用**，重连只是白花一次握手。
      // 实测：容器没在运行（引擎重启后会被停掉）时，重连一次毫无意义，
      // 还多打一条误导性的日志。所以先确认「容器到底在不在跑」：
      // 不在跑就直接抛原错误（它的 message 已经说清原因与下一步该做什么）。
      if (await this.#isContainerRunning() !== true) throw error

      this.log?.('[docker] %s 失败（%s），尝试重连一次', operation, code)
      this.connected = false
      // 旧管道上拿到的 apiPrefix 不再可信
      this.client.invalidateHandshake?.()
      try {
        await this.connect()
      } catch (reconnectError) {
        // 重连也失败 → 报**重连失败**的原因（比原始错误更有指导性）
        throw reconnectError
      }
      this.reconnects += 1
      return await run()
    }
  }

  /**
   * 容器现在在不在跑？**只读**探测，任何失败都当「不确定」（返回 undefined）。
   *
   * 用于判断「值得不值得重连」：容器没在跑的话，重连解决不了任何问题。
   */
  async #isContainerRunning() {
    try {
      const info = await this.client.inspectContainer(this.container)
      return info?.State?.Running === true
    } catch {
      // 探测本身失败（守护进程真的连不上）→ 交给重连逻辑去试
      return undefined
    }
  }

  /** 容器里可用的 shell（`bash`，或退化到 `sh`）；没有 shell 时返回 undefined。 */
  get shell() {
    if (this.capabilities?.shell === false) return undefined
    return this.capabilities?.bash === true ? 'bash' : 'sh'
  }

  /**
   * 连接：握手 → 确认容器存在 → 探测能力。
   *
   * ## 容器**没在运行**时也允许连（但只读）
   *
   * 实测：`archive` 端点在**已停止**的容器上照样可用（HEAD 给元数据、GET 给 tar），
   * 而 `exec` 不行。所以这里不再一刀切拒绝 —— 而是记下状态，
   * 把限制留给真正需要 exec 的操作去报（错误信息里会说清是「没在运行」而不是「没 shell」）。
   *
   * 范围约束（D-004）不变：**绝不创建 / 启动容器**。
   */
  async connect() {
    if (this.connected) return
    const handshake = await this.client.handshake()
    this.apiVersion = handshake.apiVersion
    this.enginePipe = handshake.pipe

    const info = await this.client.inspectContainer(this.container)
    const state = info?.State ?? {}
    this.containerRunning = state.Running === true
    this.containerInfo = info

    if (this.containerRunning) {
      // 能力探测：容器里到底有什么工具（alpine 没有 bash、distroless 什么都没有）
      this.capabilities = await this.#probeCapabilities()
    } else {
      // 没在运行 → exec 一定不可用，不必探测（也探测不了）
      this.capabilities = { shell: false, bash: false }
    }

    this.connected = true
    this.log?.(
      '[docker] 已连接容器 %s（API %s，运行中=%s，shell=%s）',
      this.container, this.apiVersion, this.containerRunning, this.shell ?? '无',
    )
  }

  /**
   * 需要 exec 的操作先过这道闸。
   *
   * 分开报两种失败，因为修法完全不同：
   *   - 容器没在运行 → 用户去 `docker start`
   *   - 容器在跑但没有 shell → 换镜像，或只用文件内容读写（走 archive）
   */
  #requireExec(operation, target) {
    if (this.containerRunning !== true) {
      throw new TransportError(
        TRANSPORT_ERROR.CONNECT_FAILED,
        `容器 "${this.container}" 没有在运行，无法${operation}。` +
        '（文件**内容**的读写仍然可用 —— 走的是 archive 端点；但列目录、取元数据、执行命令需要容器在运行。）' +
        '本插件不会替你启动容器。',
        { operation, target: String(target), retryable: true },
      )
    }
    if (this.capabilities?.shell === false) {
      throw new TransportError(
        TRANSPORT_ERROR.CONNECT_FAILED,
        `容器 "${this.container}" 里没有可用的 shell，无法${operation}。` +
        '（文件**内容**的读写仍然可用 —— 走的是 archive 端点。）',
        { operation, target: String(target), retryable: false },
      )
    }
  }

  /** Docker 是守护进程，断开只是清状态。 */
  async disconnect() {
    this.connected = false
  }

  /** 轻量探测。容器没在运行时如实说明「只能读文件内容」。 */
  async testConnection() {
    try {
      const handshake = await this.client.handshake()
      const info = await this.client.inspectContainer(this.container)
      const running = info?.State?.Running === true
      if (!running) {
        return {
          ok: false,
          code: TRANSPORT_ERROR.CONNECT_FAILED,
          detail:
            `容器未在运行（Running=${String(info?.State?.Running)}）。` +
            '文件内容仍可读写（走 archive 端点），但列目录、取元数据、执行命令都不可用。',
          image: info?.Config?.Image,
        }
      }
      return { ok: true, container: this.container, apiVersion: handshake.apiVersion, image: info?.Config?.Image }
    } catch (error) {
      return { ok: false, code: error?.code ?? TRANSPORT_ERROR.UNKNOWN, detail: String(error?.message ?? error) }
    }
  }

  /** 探测容器里的工具（决定用 bash 还是 sh）。 */
  async #probeCapabilities() {
    try {
      const result = await this.#execRaw(['sh', '-c', SCRIPTS.probe], { timeoutMs: 20_000 })
      const caps = { shell: true, bash: false }
      for (const line of result.stdout.split('\n')) {
        const [key, value] = line.trim().split('=')
        if (key === undefined || key === '') continue
        caps[key] = value === '1'
      }
      return caps
    } catch (error) {
      // 连 sh 都起不来 → 容器里没有 shell
      this.log?.('[docker] 能力探测失败（容器可能没有 shell）：%s', String(error?.message ?? error))
      return { shell: false, bash: false }
    }
  }

  /**
   * 底层 exec：create → start → 解析多路复用流 → 取退出码。
   *
   * `stdin` 参数会把字节喂给进程的标准输入。
   *
   * ⚠️ **大内容必须走 stdin，不能放进 argv**。实测：Linux 的**单个参数**上限是
   * `MAX_ARG_STRLEN` = **128 KiB**（与 `ARG_MAX` = 2 MiB 无关），
   * 超了内核直接 `E2BIG`，容器里看到的是
   * `exec /usr/bin/sh: argument list too long`（退出码 255）。
   *
   * @param {string[]} cmd
   * @param {{ timeoutMs?: number, signal?: AbortSignal, workingDir?: string,
   *           env?: string[], stdin?: Buffer }} [options]
   * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
   */
  async #execRaw(cmd, options = {}) {
    const spec = {
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      ...options.stdin === undefined ? {} : { AttachStdin: true },
      ...options.workingDir === undefined ? {} : { WorkingDir: options.workingDir },
      ...options.env === undefined ? {} : { Env: options.env },
    }
    const execId = await this.client.createExec(this.container, spec, { signal: options.signal })
    const started = await this.client.startExec(execId, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      stdin: options.stdin,
    })

    if (started.status !== 200) {
      throw new TransportError(
        TRANSPORT_ERROR.UNKNOWN,
        DockerClient.daemonError(started.status, started.body, 'exec', this.container).message,
        { operation: 'exec', target: this.container },
      )
    }

    // 多路复用流：1 = stdout、2 = stderr、3 = 守护进程错误。两路顺序不保证，所以分开收集。
    const collected = collectFrames(parseMultiplexed(started.body))
    const stdout = collected.stdout
    const stderr = collected.stderr
    // 守护进程自己的错误（streamType 3）必须浮出来，不能静默吞掉
    if (collected.systemerr !== '') {
      this.log?.('[docker] 守护进程错误流：%s', collected.systemerr.trim().slice(0, 300))
    }

    // 退出码：轮询到 Running: false **且 ExitCode 非 null** 为止。
    // ⚠️ 绝不用 `ExitCode ?? 0` —— 那会把「还在跑」或「拿不到退出码」当成成功。
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const inspected = await this.client.inspectExec(execId, { signal: options.signal })
      const value = inspected.value
      if (inspected.status === 200 && value?.Running === false && value?.ExitCode !== null && value?.ExitCode !== undefined) {
        return { code: Number(value.ExitCode), stdout, stderr }
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    // 超时没落定：如实说明，而不是假装成功
    throw new TransportError(
      TRANSPORT_ERROR.TIMEOUT,
      `exec 结束但退出码一直没落定（exec ${execId}）`,
      { operation: 'exec', target: this.container, retryable: true },
    )
  }

  /**
   * 在容器里跑一个**常量脚本**，用户数据经位置参数传入。
   *
   * 与 WSL 后端同一套安全模型：**用户数据绝不进 shell 字符串**。
   * 需要内联内容时（例如文件内容），用 `options.body` 传一个**完整的脚本**，
   * 而不是往常量脚本后面追加 —— 追加会被脚本末尾的 `exit` 截断。
   *
   * @param {string} scriptKey
   * @param {string[]} args 位置参数（路径之类的短数据）
   * @param {{ body?: string, timeoutMs?: number, signal?: AbortSignal }} [options]
   */
  async #runScript(scriptKey, args, options = {}) {
    const script = options.body ?? SCRIPTS[scriptKey]
    if (script === undefined) throw new Error(`未知脚本：${scriptKey}`)
    const shell = this.shell
    const cmd = shell === 'bash'
      ? ['bash', '-c', script, 'sh', ...args]
      : ['sh', '-c', script, 'sh', ...args]
    return this.#execRaw(cmd, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      stdin: options.stdin,
    })
  }

  /**
   * 解析规范绝对路径。
   *
   * 公开方法都经 {@link DockerTransport.#withReconnect}：连接层失败会重连一次再试。
   */
  async realpath(path, options = {}) {
    return this.#withReconnect('realpath', () => this.#realpathImpl(path, options))
  }

  /** 解析规范绝对路径（实现）。 */
  async #realpathImpl(path, options = {}) {
    throwIfAborted(options.signal, 'realpath', path)
    const result = await this.#runScript('realpath', [String(path)], {
      timeoutMs: FILE_TIMEOUT_MS,
      signal: options.signal,
    })
    if (result.code === 2) {
      throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `"${path}" 不存在`, {
        operation: 'realpath', target: String(path), retryable: false,
      })
    }
    if (result.code !== 0) {
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, `realpath 失败（exit ${result.code}）：${result.stderr}`, {
        operation: 'realpath', target: String(path),
      })
    }
    return result.stdout.trim()
  }

  /**
   * 取元信息。
   *
   * **优先走 archive 的 HEAD**（无 shell 依赖 —— distroless 容器里也能用）；
   * HEAD 拿不到可用信息时退回 exec 的 `stat`（信息更全，能拿到符号链接类型）。
   */
  async stat(path, options = {}) {
    return this.#withReconnect('stat', () => this.#statImpl(path, options))
  }

  async #statImpl(path, options = {}) {
    throwIfAborted(options.signal, 'stat', path)

    // 1) HEAD archive：守护进程直接给元数据，不需要容器里有任何工具
    try {
      const head = await this.client.headArchive(this.container, String(path), {
        signal: options.signal,
        timeoutMs: FILE_TIMEOUT_MS,
      })
      if (head.status === 404) {
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `"${path}" 不存在`, {
          operation: 'stat', target: String(path), retryable: false,
        })
      }
      if (head.status === 200) {
        const parsed = parsePathStatHeader(head.headers['x-docker-container-path-stat'])
        if (parsed !== undefined) {
          return {
            type: parsed.type,
            size: parsed.size,
            mtimeMs: parsed.mtimeMs,
            mode: parsed.mode,
            uid: 0,
            gid: 0,
            kind: parsed.kind,
          }
        }
      }
    } catch (error) {
      if (error instanceof TransportError && error.code === TRANSPORT_ERROR.NOT_FOUND) throw error
      this.log?.('[docker] HEAD archive 取元数据失败，退回 exec：%s', String(error?.message ?? error))
    }

    // 2) 退回 exec（信息更全，但需要容器在跑且有 shell）
    this.#requireExec('取文件元数据', path)
    const result = await this.#runScript('statNul', [String(path)], {
      timeoutMs: FILE_TIMEOUT_MS,
      signal: options.signal,
    })
    if (result.code === 2) {
      throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `"${path}" 不存在`, {
        operation: 'stat', target: String(path), retryable: false,
      })
    }
    if (result.code !== 0) {
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, `stat 失败（exit ${result.code}）：${result.stderr}`, {
        operation: 'stat', target: String(path),
      })
    }
    const [kind, size, mtimeSeconds, mode, uid, gid] = result.stdout.split('\0')
    return {
      type: typeFromStatKind(kind),
      size: Number(size ?? 0),
      mtimeMs: Math.round(Number(mtimeSeconds ?? 0) * 1000),
      mode: Number.parseInt(String(mode ?? '0'), 8),
      uid: Number(uid ?? 0),
      gid: Number(gid ?? 0),
      kind: String(kind ?? ''),
    }
  }

  /**
   * 列一层目录。
   *
   * 走 exec（`find -exec stat ... +`），不是 archive —— archive 的 tar 头给不了
   * 完整的权限与符号链接语义。脚本本身是 busybox/coreutils 双兼容的。
   */
  async readdir(path, options = {}) {
    return this.#withReconnect('readdir', () => this.#readdirImpl(path, options))
  }

  async #readdirImpl(path, options = {}) {
    throwIfAborted(options.signal, 'readdir', path)
    this.#requireExec('列目录', path)
    const result = await this.#runScript('readdir', [String(path)], {
      timeoutMs: FILE_TIMEOUT_MS,
      signal: options.signal,
    })
    if (result.code === 2) {
      throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `"${path}" 不是目录或不存在`, {
        operation: 'readdir', target: String(path), retryable: false,
      })
    }
    if (result.code !== 0) {
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, `readdir 失败（exit ${result.code}）：${result.stderr}`, {
        operation: 'readdir', target: String(path),
      })
    }
    return parseReaddirOutput(result.stdout, String(path))
  }

  /**
   * 读文件 —— 走 **archive 端点**（不依赖容器里的任何工具）。
   */
  async readFile(path, options = {}) {
    return this.#withReconnect('readFile', () => this.#readFileImpl(path, options))
  }

  async #readFileImpl(path, options = {}) {
    throwIfAborted(options.signal, 'readFile', path)
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    // 符号链接要解析后重取；给个深度上限，防链接环把栈打爆
    const depth = options.__symlinkDepth ?? 0
    if (depth > 8) {
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, `"${path}" 的符号链接嵌套太深（可能成环）`, {
        operation: 'readFile', target: String(path), retryable: false,
      })
    }

    const response = await this.client.getArchive(this.container, String(path), {
      signal: options.signal,
      timeoutMs: FILE_TIMEOUT_MS,
    })
    if (response.status === 404) {
      throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `"${path}" 不存在`, {
        operation: 'readFile', target: String(path), retryable: false,
      })
    }
    if (response.status !== 200) {
      throw new TransportError(
        TRANSPORT_ERROR.UNKNOWN,
        `读取失败（HTTP ${response.status}）：${response.body.toString('utf8').slice(0, 200)}`,
        { operation: 'readFile', target: String(path) },
      )
    }

    let entry
    try {
      entry = extractSingleEntry(response.body, String(path))
    } catch (error) {
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, `解析 archive 失败：${error?.message ?? error}`, {
        operation: 'readFile', target: String(path), cause: error,
      })
    }

    if (entry.type === TAR_TYPE.DIRECTORY) {
      throw new TransportError(TRANSPORT_ERROR.WRONG_TYPE, `"${path}" 是目录，不是文件`, {
        operation: 'readFile', target: String(path), retryable: false,
      })
    }

    // ⚠️ 实测：archive 端点对符号链接返回的是**链接本身**（数据为空），
    // 不跟随目标。而调用方（agent 的 read 工具）期望的是「读到内容」。
    // 所以这里先 realpath 解析出真实路径，再重新取一次。
    if (entry.type === TAR_TYPE.SYMLINK) {
      const resolved = await this.realpath(String(path), { signal: options.signal })
      if (resolved !== String(path)) {
        return this.readFile(resolved, { ...options, __symlinkDepth: depth + 1 })
      }
      throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `"${path}" 是悬空符号链接`, {
        operation: 'readFile', target: String(path), retryable: false,
      })
    }

    if (entry.size > maxBytes) {
      throw new TransportError(
        TRANSPORT_ERROR.TOO_LARGE,
        `"${path}" 有 ${entry.size} 字节，超过上限 ${maxBytes}`,
        { operation: 'readFile', target: String(path), retryable: false },
      )
    }

    const buffer = entry.data
    if (options.encoding === undefined) return buffer
    if (buffer.includes(0)) {
      throw new TransportError(TRANSPORT_ERROR.NOT_TEXT, `"${path}" 含 NUL 字节，不是文本`, {
        operation: 'readFile', target: String(path), retryable: false,
      })
    }
    return decodeUtf8Strict(buffer, String(path))
  }

  /**
   * 原子写。
   *
   * ## 为什么是「archive 传临时文件 + exec rename」
   *
   * 直觉上应该把内容喂给容器里的 `base64 -d > tmp`。但**内容不能进 argv**：
   * Linux 的**单个参数**上限是 `MAX_ARG_STRLEN` = **128 KiB**（与 `ARG_MAX` 无关），
   * 超了内核直接 `E2BIG`，容器里看到 `exec /usr/bin/sh: argument list too long`
   * （退出码 255）。实测阈值：base64 后约 130 956 字节。
   *
   * 而 `exec/start` 的 **stdin 通道在当前守护进程上送不进去**（实测：请求体、
   * chunked、`Upgrade` 三种写法都试过 —— 要么 400、要么死锁、要么静默丢掉 stdin，
   * 文件最后是 0 字节）。所以不走 stdin。
   *
   * 正确解法是用 **archive 端点**：内容是 tar 的**请求体**，不受 argv 限制；
   * 先传到目标目录里的临时名字，再用 `mv -f` 原子替换 —— 既有原子性，又没有大小上限。
   * （`docker cp` 内部也是走这个端点。）
   *
   * 小文件走同一条路：不必为 1 KiB 和 100 MiB 维护两套代码。
   */
  async writeFileAtomic(path, data, options = {}) {
    return this.#withReconnect('writeFileAtomic', () => this.#writeFileAtomicImpl(path, data, options))
  }

  async #writeFileAtomicImpl(path, data, options = {}) {
    throwIfAborted(options.signal, 'writeFileAtomic', path)
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), options.encoding ?? 'utf8')

    // 写文件需要 exec（archive 端点没有 rename 原语，原子替换得靠容器内的 mv）
    this.#requireExec('写文件', path)

    const target = String(path)
    // 临时文件名放在**目标目录**里：rename(2) 只在同一文件系统内保证原子。
    // 放到 /tmp 就可能跨挂载点，`mv` 会退化成「复制 + 删除」，那就不原子了。
    const dir = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) || '/' : '.'
    const base = target.split('/').pop() || 'file'
    const tempName = `.dsh-mr.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`
    const tempPath = `${dir === '/' ? '' : dir}/${tempName}`

    const tar = buildTar({ name: tempName, content: buffer })
    const put = await this.client.putArchive(this.container, dir, tar, {
      signal: options.signal,
      timeoutMs: FILE_TIMEOUT_MS,
    })
    if (put.status !== 200) {
      throw new TransportError(
        TRANSPORT_ERROR.UNKNOWN,
        `上传失败（HTTP ${put.status}）：${put.body.toString('utf8').slice(0, 200)}`,
        { operation: 'writeFileAtomic', target },
      )
    }

    // 原子替换。失败时清掉临时文件，不留垃圾。
    const moved = await this.#execRaw(['mv', '-f', '--', tempPath, target], {
      timeoutMs: FILE_TIMEOUT_MS,
      signal: options.signal,
    })
    if (moved.code !== 0) {
      await this.#execRaw(['rm', '-f', '--', tempPath], {
        timeoutMs: FILE_TIMEOUT_MS,
      }).catch(() => {})
      throw new TransportError(
        TRANSPORT_ERROR.UNKNOWN,
        `原子替换失败（exit ${moved.code}）：${moved.stderr}`,
        { operation: 'writeFileAtomic', target },
      )
    }
    void base
  }

  /**
   * 执行命令 —— 调用方给的就是 shell 命令，所以这里必须经 shell。
   * 优先 `bash -lc`（拿到登录环境），容器里没有 bash 时退化到 `sh -c`。
   */
  async exec(command, options = {}) {
    return this.#withReconnect('exec', () => this.#execImpl(command, options))
  }

  async #execImpl(command, options = {}) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('exec: command 不能为空')
    }
    if (command.includes('\0')) {
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, '命令含 NUL 字节', { operation: 'exec' })
    }
    this.#requireExec('执行命令', this.container)

    const shell = this.shell
    const cmd = shell === 'bash' ? ['bash', '-lc', command] : ['sh', '-c', command]
    const result = await this.#execRaw(cmd, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal,
      workingDir: options.cwd,
      env: options.env === undefined ? undefined : Object.entries(options.env).map(([key, value]) => `${key}=${value}`),
    })
    if (result.stdout !== '') options.onStdout?.(Buffer.from(result.stdout, 'utf8'))
    if (result.stderr !== '') options.onStderr?.(Buffer.from(result.stderr, 'utf8'))
    return result
  }
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 解析 `X-Docker-Container-Path-Stat` 头（base64 的 JSON）。
 *
 * ⚠️ 里面的 `mode` 是 **Go 的 `os.FileMode`**，不是 POSIX 的 `st_mode`：
 *   - 目录：bit31（`0x80000000`）
 *   - 符号链接：bit27（`0x08000000`）
 *   - 普通文件：没有任何类型位
 * 权限位（低 9 位）与 POSIX 一致。
 *
 * 当成 `st_mode` 解析会把目录认成普通文件（八进制看起来也「像」一个合法权限）。
 *
 * @param {string|undefined} headerValue
 * @returns {{ type: string, size: number, mtimeMs: number, mode: number, kind: string }|undefined}
 */
export function parsePathStatHeader(headerValue) {
  if (typeof headerValue !== 'string' || headerValue === '') return undefined
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined

  const goMode = Number(parsed.mode ?? 0)
  const isDirectory = (goMode & 0x80000000) !== 0
  const isSymlink = (goMode & 0x08000000) !== 0
  const type = isDirectory ? 'directory' : isSymlink ? 'symlink' : 'file'

  const mtime = typeof parsed.mtime === 'string' ? Date.parse(parsed.mtime) : Number.NaN

  return {
    type,
    size: Number(parsed.size ?? 0),
    mtimeMs: Number.isFinite(mtime) ? mtime : 0,
    // 只保留权限位（低 9 位），与 exec 路径给出的 st_mode 对齐
    mode: goMode & 0o777,
    kind: parsed.name ?? '',
  }
}

/**
 * 解析 `readdir` 的输出。
 *
 * 每条形如 `<完整路径>|<类型>|<大小>|<mtime 秒>|<权限>`，记录之间用 **NUL** 分隔。
 * `stat %F` 在 busybox 与 coreutils 上都给同样的英文描述（实测）。
 *
 * @param {string} stdout
 * @param {string} basePath 请求的目录（用来把完整路径还原成名字）
 * @returns {Array<{ name: string, type: string, size: number, mtimeMs: number, kind: string }>}
 */
export function parseReaddirOutput(stdout, basePath) {
  const prefix = basePath.endsWith('/') ? basePath : `${basePath}/`
  const entries = []
  for (const record of stdout.split('\0')) {
    if (record === '') continue
    const fields = record.split('|')
    if (fields.length < 5) continue
    const fullPath = fields[0]
    // 只要直接子项（`find -maxdepth 1` 已保证，这里再兜一层）
    if (!fullPath.startsWith(prefix)) continue
    const name = fullPath.slice(prefix.length)
    if (name === '' || name.includes('/')) continue
    entries.push({
      name,
      type: typeFromStatKind(fields[1]),
      size: Number(fields[2] ?? 0),
      mtimeMs: Math.round(Number(fields[3] ?? 0) * 1000),
      kind: fields[1],
    })
  }
  return entries
}

/** `stat --printf %F` 的取值 → 我们的类型。 */
function typeFromStatKind(kind) {
  const value = String(kind ?? '')
  if (value === 'directory') return 'directory'
  if (value === 'regular file' || value === 'regular empty file') return 'file'
  if (value === 'symbolic link') return 'symlink'
  return 'other'
}

/** 严格 UTF-8 解码。 */
function decodeUtf8Strict(buffer, path) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    return decoder.decode(buffer)
  } catch (error) {
    throw new TransportError(TRANSPORT_ERROR.NOT_TEXT, `"${path}" 不是合法 UTF-8 文本`, {
      operation: 'readFile', target: path, retryable: false, cause: error,
    })
  }
}

/** 取消检查：abort 是终态。 */
function throwIfAborted(signal, operation, target) {
  if (signal?.aborted === true) {
    throw new TransportError(TRANSPORT_ERROR.ABORTED, `${operation} 已被取消`, {
      operation, target: String(target),
    })
  }
}
