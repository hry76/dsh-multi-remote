/**
 * WSL transport —— 用 `wsl.exe` 驱动一个 WSL2 发行版。
 *
 * ## 为什么是 exec-only
 *
 * `\\wsl.localhost\<distro>\...` 看起来是「真实本地路径」，可以零代码复用镜像层。
 * 但实测否掉了它：
 *
 *   - 宿主 git 在 UNC 上每次轮次边界要 **20 秒以上**
 *     （2077 文件仓库：`git status` 4.9s、`git diff --numstat` 18.6s）
 *   - **符号链接不可达**（`lstat`→EISDIR、`stat`→ENOENT、`readlink`→EISDIR；
 *     `/bin`、`/lib`、`/sbin` 进不去，`/usr/bin` 里 83/300 个 stat 直接 ENOENT）
 *   - **元数据是编的**（`mode` 恒 0666、uid/gid 恒 0、`nlink` 与目录 size 伪造）
 *   - **`fs.watch` 直接 EISDIR**
 *   - 逐文件 9P 开销约 **100×**（~0.8ms/stat vs 本地 NTFS ~0.008ms）
 *
 * 所以文件操作全部在**发行版内部**用一次 `wsl.exe -e` 完成。
 *
 * ## 三条实测得来的硬约束
 *
 * 1. **绝不 SIGKILL `wsl.exe`** —— 会把 relay 打死，需要提权重启服务。
 *    取消必须在**发行版内部**做（`timeout --kill-after`）。
 * 2. **并发 ≤ 4** —— 8 路以上会出现 30 秒级停顿与 50–87% 失败率。
 * 3. **用户数据绝不拼进 shell 字符串** —— `wsl.exe -e` 传 argv 是逐字的，
 *    配合「常量脚本 + 位置参数」可以完全避免引号问题。
 *
 * ## 输出编码（实测）
 *
 *   - `wsl.exe` **自己**的消息（`-l -q`、`--status`、致命错误）是 **UTF-16LE 无 BOM**
 *   - **子进程**输出是原始 UTF-8
 *   - 一次调用可能两种编码都有（致命错误打在 stdout 上）
 *   - 致命错误：**exit `-1` + stdout 里的 `Wsl/<CODE>`**（不是 stderr！）
 */
import { execFile } from 'node:child_process'

import { Transport, TRANSPORT_ERROR, TransportError } from './transport.js'

/** 并发上限。实测：8 路以上会 30 秒级停顿 + 大量失败。 */
export const MAX_CONCURRENT = 4

/** 每次 `wsl.exe` 调用的固定开销约 106ms，所以超时给足。 */
const DEFAULT_TIMEOUT_MS = 60_000

/** 单次文件操作超时（比 exec 短，因为它不该慢）。 */
const FILE_TIMEOUT_MS = 30_000

/** 在发行版内部执行的**常量脚本**。用户数据一律经位置参数传入。 */
const SCRIPTS = {
  /**
   * 取规范绝对路径。
   * `readlink -f` 对不存在的路径也会给出结果（解析掉符号链接），
   * 所以额外用 `-e` 判断存在性。
   */
  realpath: `#!/bin/sh
p="$1"
if [ -e "$p" ]; then
  readlink -f -- "$p" 2>/dev/null || printf '%s' "$p"
  exit 0
fi
printf '%s' "$p"
exit 2
`,

  /**
   * 取元信息。输出用 NUL 分隔，避免文件名里的换行/空格干扰。
   * 字段：类型 / 大小 / mtime（秒）/ 权限 / uid / gid
   * 悬空符号链接单独处理（`stat -L` 会失败）。
   *
   * ⚠️ **busybox 的 `stat` 没有 `--printf`**，而 `-c` **也不解释 `\0`**
   * （实测：busybox 与 GNU 的 `stat -c '%F\0'` 都会把 `\0` 原样输出）。
   * 所以退路是「`-c` 取字段 → 用 `printf` 自己拼 NUL」——
   * `printf` 的 `\0` 两个实现都认（实测过）。
   */
  statNul: `#!/bin/sh
p="$1"
if [ -L "$p" ] && [ ! -e "$p" ]; then
  printf 'symbolic link\\0%s\\0%s\\0%s\\0%s\\0%s\\0' 0 0 777 0 0
  exit 0
fi
[ -e "$p" ] || exit 2
# GNU coreutils：--printf 会解释 \\0，一次调用拿全
if stat -L --printf '' -- "$p" >/dev/null 2>&1; then
  exec stat -L --printf '%F\\0%s\\0%Y\\0%a\\0%u\\0%g\\0' -- "$p"
fi
# busybox 退路（字段顺序必须与上面完全一致）
info=$(stat -L -c '%F|%s|%Y|%a|%u|%g' -- "$p" 2>/dev/null) || exit 2
ft=\${info%%|*}; rest=\${info#*|}
sz=\${rest%%|*}; rest=\${rest#*|}
mt=\${rest%%|*}; rest=\${rest#*|}
md=\${rest%%|*}; rest=\${rest#*|}
ui=\${rest%%|*}; gi=\${rest#*|}
printf '%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0' "$ft" "$sz" "$mt" "$md" "$ui" "$gi"
`,

  /**
   * 列一层目录。**一次调用拿全**（类型 + 大小 + mtime + 符号链接）。
   * `-printf` 里 %y 给类型（d/f/l），%T@ 给 mtime（秒.纳秒）。
   *
   * ⚠️ **busybox 的 `find` 没有 `-printf`**（实测 Docker Desktop 的
   * `docker-desktop` 发行版：`find: unrecognized: -printf`，BusyBox v1.37；
   * Alpine-on-WSL 同理）。所以有两条路：
   *   - GNU：`-printf`，一次拿全、NUL 分隔、文件名含换行也不怕（**优先**）
   *   - busybox：`-exec` + `stat -c`，**字段顺序与上面完全一致**，
   *     所以宿主侧的解析器一行都不用改
   */
  readdir: `#!/bin/sh
d="$1"
[ -d "$d" ] || exit 2
if find -- "$d" -mindepth 1 -maxdepth 1 -printf '' >/dev/null 2>&1; then
  exec find -- "$d" -mindepth 1 -maxdepth 1 -printf '%f\\0%y\\0%s\\0%T@\\0'
fi
find -- "$d" -mindepth 1 -maxdepth 1 -exec sh -c '
for f in "$@"; do
  info=$(stat -c "%F|%s|%Y" -- "$f" 2>/dev/null) || continue
  ft=\${info%%|*}; rest=\${info#*|}
  sz=\${rest%%|*}; mt=\${rest#*|}
  case "$ft" in
    directory) k=d ;;
    symbolic*) k=l ;;
    *) k=f ;;
  esac
  printf "%s\\0%s\\0%s\\0%s\\0" "\${f##*/}" "$k" "$sz" "$mt"
done
' sh {} +
exit 0
`,

  /**
   * 读文件，base64 输出（避免二进制/NUL 破坏协议）。
   * `head -c max+1` 让我们能在宿主侧判断「超限」而不是被静默截断。
   */
  readFile: `#!/bin/sh
p="$1"
max="$2"
[ -f "$p" ] || exit 2
head -c "$((max + 1))" -- "$p" | base64 -w 0
`,

  /**
   * 原子写：目标目录内建临时文件 → 写 → 改权限 → rename。
   * rename(2) 在 ext4 上是原子的。
   * base64 内容从 stdin 读，避免命令行长度限制与转义问题。
   */
  writeFileAtomic: `#!/bin/sh
p="$1"
dir=$(dirname -- "$p")
tmp="$dir/.dsh-mr.$$.tmp"
cleanup() { rm -f -- "$tmp" 2>/dev/null; }
trap cleanup EXIT INT TERM
if ! base64 -d > "$tmp" 2>/dev/null; then
  exit 3
fi
# 目标已存在时沿用它的权限（新文件默认 644 & umask）
if [ -e "$p" ]; then
  chmod --reference="$p" -- "$tmp" 2>/dev/null || true
fi
mv -f -- "$tmp" "$p" || exit 4
trap - EXIT
exit 0
`,

  /** 存在性 + 类型快速判断（避免为一次 stat 拉全套）。 */
  exists: `#!/bin/sh
[ -e "$1" ] || [ -L "$1" ] || exit 2
exit 0
`,

  /**
   * **批量读**：一次调用拉一批文件（镜像首次拉取的主要提速手段）。
   *
   * 背景（2026-10-09 实测）：197 个小文件逐个 `readFile` 要 22 秒 ——
   * 每个文件一次 `wsl.exe` spawn，全部串行。批量后 ~10 次调用解决，
   * 复用 4 个并发槽位，实测降到 ~3 秒。
   *
   * 输出协议（NUL 分隔，与 `readdir` 一致；base64 避免二进制/NUL 破坏协议）：
   *   对每个路径 p：输出 `p\0<base64 字节数或 -1>\0<base64 内容>\0`
   *   - 文件缺失/不可读：长度 = -1，无内容段
   *   - 每个文件的 base64 是**一行连续输出**（`base64 -w 0`），分隔靠 NUL
   * `head -c "$((max+1))"` 让宿主侧能判「超限」而不是被静默截断：
   * 读到的字节数 > max 即报 TOO_LARGE，与单个 readFile 的契约一致。
   */
  readFilesBatch: `#!/bin/sh
max="$1"
shift
for p in "$@"; do
  if [ -f "$p" ]; then
    n=$(head -c "$((max + 1))" -- "$p" | base64 -w 0 | wc -c)
    printf '%s\\0%s\\0' "$p" "$n"
    head -c "$((max + 1))" -- "$p" | base64 -w 0
    printf '\\0'
  else
    printf '%s\\0-1\\0' "$p"
  fi
done
exit 0
`,
}

/**
 * WSL transport。
 */
export class WslTransport extends Transport {
  /**
   * @param {object} options
   * @param {string} options.distro 发行版名（如 `Ubuntu-24.04`）
   * @param {string} [options.username] 以哪个 Linux 用户执行（默认发行版默认用户）
   * @param {string} [options.wslExe] `wsl.exe` 路径（默认靠 PATH）
   * @param {number} [options.maxConcurrent] 并发上限（默认 {@link MAX_CONCURRENT}）
   * @param {number} [options.timeoutMs]
   * @param {(message: string, ...rest: unknown[]) => void} [options.log]
   */
  constructor(options) {
    super('wsl')
    if (typeof options?.distro !== 'string' || options.distro.trim() === '') {
      throw new Error('WslTransport 需要 distro（发行版名）')
    }
    this.distro = options.distro.trim()
    this.username = options.username
    /**
     * `wsl.exe` 的调用方式。
     *
     * 可以是字符串（靠 PATH 找 `wsl.exe`），也可以是**命令前缀数组**
     * （例如 `['node', '/path/to/fake.mjs']`）—— 后者让测试能注入假实现，
     * 而不必在 Windows 上跟 `.cmd` 包装与引号嵌套较劲。
     * @type {string | string[]}
     */
    this.wslExe = options.wslExe ?? 'wsl.exe'
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT
    // 镜像层并发拉文件时的礼貌上限：与 #acquire 的硬限流一致（再多也只是排队）
    this.readConcurrency = this.maxConcurrent
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.log = options.log

    /** 连接状态。WSL 是本机进程，没有真正的「连接」，但保持契约一致。 */
    this.connected = false
    /** 发行版默认用户（探测一次，用于给 cwd 一个稳定值）。 */
    this.defaultCwd = undefined
    /**
     * 发行版里用哪个 shell（`'bash'` / `'sh'`）。
     *
     * 首次用到时探测一次并缓存 —— **POSIX shell 才是硬要求，bash 只是常见**。
     * 实测：Docker Desktop 的 `docker-desktop` 发行版里只有 busybox 的 `sh`，
     * 没有 bash；写死 `bash -lc` 会让它直接连不上（`execvpe(bash) failed`）。
     * @type {'bash' | 'sh' | undefined}
     */
    this.shell = undefined
    /** shell 探测的单飞 promise（见 `#resolveShell`）。 */
    this.shellProbe = undefined

    /** 在途调用数（限流用）。 */
    this.inFlight = 0
    /** @type {Array<() => void>} FIFO 等待队列。 */
    this.queue = []
  }

  /**
   * 获取一个执行槽位 —— **硬限流**。
   *
   * 实测：8 路以上并发会让 WSL relay 出现 30 秒级停顿与 50–87% 失败率，
   * 更激进的突发会把 relay 彻底打死（需要提权重启服务）。
   * 所以这里不是「建议」，是硬上限。
   */
  async #acquire() {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1
      return
    }
    await new Promise((resolve) => this.queue.push(resolve))
    this.inFlight += 1
  }

  /** 释放槽位并唤醒队首。 */
  #release() {
    this.inFlight -= 1
    const next = this.queue.shift()
    if (next !== undefined) next()
  }

  /** 建立「连接」= 确认发行版存在且可执行。 */
  async connect() {
    if (this.connected) return
    const list = await listDistros({ wslExe: this.wslExe })
    if (!list.includes(this.distro)) {
      throw new TransportError(
        TRANSPORT_ERROR.CONNECT_FAILED,
        `找不到 WSL 发行版 "${this.distro}"。可用：${list.join(', ') || '(无)'}`,
        { operation: 'connect', target: this.distro, retryable: false },
      )
    }
    // 预热 + 取默认 cwd（顺带确认能真的执行）
    const probe = await this.exec('pwd', { timeoutMs: 30_000 })
    if (probe.code !== 0) {
      throw new TransportError(
        TRANSPORT_ERROR.CONNECT_FAILED,
        `发行版 "${this.distro}" 无法执行命令：${probe.stderr || probe.stdout}`,
        { operation: 'connect', target: this.distro },
      )
    }
    this.defaultCwd = probe.stdout.trim() || '/'
    this.connected = true
  }

  /** WSL 是本机进程，断开只是清状态。 */
  async disconnect() {
    this.connected = false
  }

  /** 轻量探测。 */
  async testConnection() {
    try {
      const list = await listDistros({ wslExe: this.wslExe })
      if (!list.includes(this.distro)) {
        return { ok: false, code: TRANSPORT_ERROR.CONNECT_FAILED, detail: `发行版不存在。可用：${list.join(', ')}` }
      }
      const probe = await this.exec('pwd')
      return probe.code === 0
        ? { ok: true, distro: this.distro, cwd: probe.stdout.trim() }
        : { ok: false, code: TRANSPORT_ERROR.CONNECT_FAILED, detail: probe.stderr || probe.stdout }
    } catch (error) {
      return { ok: false, code: error?.code ?? TRANSPORT_ERROR.UNKNOWN, detail: String(error?.message ?? error) }
    }
  }

  /**
   * 在发行版内部跑一个**常量脚本**，用户数据经位置参数传入。
   *
   * 这是整个 transport 的安全核心：**用户数据永远不进 shell 字符串**。
   * `wsl.exe -e` 传 argv 是逐字的（不经 shell），所以 `$1`/`$2` 拿到的是原样数据。
   *
   * @param {string} scriptKey {@link SCRIPTS} 的键
   * @param {string[]} args 位置参数（用户数据）
   * @param {{ timeoutMs?: number, signal?: AbortSignal, stdin?: Buffer }} [options]
   * @returns {Promise<{ code: number, stdout: Buffer, stderr: string }>}
   */
  async #runScript(scriptKey, args, options = {}) {
    const script = SCRIPTS[scriptKey]
    if (script === undefined) throw new Error(`未知脚本：${scriptKey}`)

    await this.#acquire()
    try {
      const argv = [
        '-d', this.distro,
        ...this.username === undefined ? [] : ['-u', this.username],
        // 常量脚本 + 位置参数：数据零转义风险
        '-e', 'sh', '-c', script, 'sh',
        ...args,
      ]
      return await this.#spawn(argv, options)
    } finally {
      this.#release()
    }
  }

  /**
   * 底层 spawn：处理编码、退出码、超时、取消。
   *
   * 取消策略：**绝不 SIGKILL `wsl.exe`**（实测会把 relay 打死）。
   * 这里先发 SIGTERM（给 wsl.exe 一个正常收尾的机会），
   * 并且明确把这种情况报成 ABORTED/TIMEOUT，而不是静默当作命令失败。
   */
  #spawn(argv, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const { command, args } = splitWslCommand(this.wslExe, argv)
    return new Promise((resolve, reject) => {
      let settled = false
      let timer
      const child = execFile(command, args, {
        timeout: 0, // 自己管超时，便于区分「超时」与「取消」
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'buffer',
      }, (error, stdout, stderr) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        options.signal?.removeEventListener?.('abort', onAbort)

        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''))
        const err = Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr ?? ''))
        const code = error === null || error === undefined ? 0 : Number(error.code ?? 1)

        // 致命错误：exit -1 + stdout 里的 Wsl/<CODE>（不是 stderr！）
        if (code === -1 || code === 0xFFFFFFFF) {
          reject(this.#classifyFatal(out))
          return
        }
        resolve({ code, stdout: out, stderr: decodeWslError(err) })
      })

      const onAbort = () => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        // 温和终止，**不 SIGKILL**
        try {
          child.kill('SIGTERM')
        } catch {
          // 已经退出
        }
        reject(new TransportError(TRANSPORT_ERROR.ABORTED, 'WSL 命令已被取消', {
          operation: 'exec',
          target: this.distro,
        }))
      }

      if (options.signal?.aborted === true) {
        onAbort()
        return
      }
      options.signal?.addEventListener?.('abort', onAbort, { once: true })

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return
          settled = true
          try {
            child.kill('SIGTERM')
          } catch {
            // 已退出
          }
          reject(new TransportError(TRANSPORT_ERROR.TIMEOUT, `WSL 命令超时（${timeoutMs}ms）`, {
            operation: 'exec',
            target: this.distro,
          }))
        }, timeoutMs)
        // 刻意**不 unref** —— 这是唯一的结算定时器
      }

      // stdin：只有需要喂数据时才写；否则立刻 end（否则读 stdin 的命令会挂住）
      if (options.stdin !== undefined) {
        child.stdin?.end(options.stdin)
      } else {
        child.stdin?.end()
      }
    })
  }

  /** 把 `Wsl/<CODE>` 之类的致命错误转成结构化错误。 */
  #classifyFatal(stdoutBuffer) {
    const text = decodeWslOutput(stdoutBuffer)
    const match = /Wsl\/([A-Z_]+)/.exec(text)
    const code = match?.[1] ?? 'UNKNOWN'
    const hint = {
      E_DISTRO_NOT_FOUND: '发行版不存在',
      E_INVALIDARG: '参数非法（相对路径的 --cd 也会报这个）',
      E_ACCESSDENIED: '访问被拒（Session 0 / 服务上下文下 wsl.exe 不可用）',
      E_NOT_SUPPORTED: '当前 WSL 版本不支持该操作',
    }[code] ?? text.trim().slice(0, 200)

    return new TransportError(TRANSPORT_ERROR.CONNECT_FAILED, `WSL 致命错误 ${code}：${hint}`, {
      operation: 'wsl',
      target: this.distro,
      retryable: false,
    })
  }

  /** 解析规范绝对路径。 */
  async realpath(path, options = {}) {
    throwIfAborted(options.signal, 'realpath', path)
    const result = await this.#runScript('realpath', [String(path)], {
      timeoutMs: FILE_TIMEOUT_MS,
      signal: options.signal,
    })
    if (result.code === 2) {
      throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `"${path}" 不存在`, {
        operation: 'realpath',
        target: String(path),
        retryable: false,
      })
    }
    if (result.code !== 0) {
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, `realpath 失败（exit ${result.code}）：${result.stderr}`, {
        operation: 'realpath',
        target: String(path),
      })
    }
    return decodeUtf8(result.stdout).trim()
  }

  /** 取元信息。 */
  async stat(path, options = {}) {
    throwIfAborted(options.signal, 'stat', path)
    const result = await this.#runScript('statNul', [String(path)], {
      timeoutMs: FILE_TIMEOUT_MS,
      signal: options.signal,
    })
    if (result.code === 2) {
      throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `"${path}" 不存在`, {
        operation: 'stat',
        target: String(path),
        retryable: false,
      })
    }
    if (result.code !== 0) {
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, `stat 失败（exit ${result.code}）：${result.stderr}`, {
        operation: 'stat',
        target: String(path),
      })
    }
    const fields = splitNul(result.stdout)
    const [kind, size, mtimeSeconds, mode, uid, gid] = fields
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

  /** 列一层目录 —— 一次调用拿全。 */
  async readdir(path, options = {}) {
    throwIfAborted(options.signal, 'readdir', path)
    const result = await this.#runScript('readdir', [String(path)], {
      timeoutMs: FILE_TIMEOUT_MS,
      signal: options.signal,
    })
    if (result.code === 2) {
      throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `"${path}" 不是目录或不存在`, {
        operation: 'readdir',
        target: String(path),
        retryable: false,
      })
    }
    if (result.code !== 0) {
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, `readdir 失败（exit ${result.code}）：${result.stderr}`, {
        operation: 'readdir',
        target: String(path),
      })
    }

    const fields = splitNul(result.stdout)
    const entries = []
    // 每组 4 个字段：名字 / 类型 / 大小 / mtime（秒.纳秒）
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const name = fields[i]
      if (name === '') continue
      const kind = fields[i + 1]
      entries.push({
        name,
        type: typeFromFindKind(kind),
        size: Number(fields[i + 2] ?? 0),
        mtimeMs: Math.round(Number.parseFloat(fields[i + 3] ?? '0') * 1000),
        kind,
      })
    }
    return entries
  }

  /**
   * 读文件。
   *
   * `maxBytes` 是**硬上限**：超过就失败，绝不截断
   * （宿主契约里 `FS_TOO_LARGE` 就是为这个存在的）。
   */
  async readFile(path, options = {}) {
    throwIfAborted(options.signal, 'readFile', path)
    const maxBytes = options.maxBytes ?? 32 * 1024 * 1024
    const result = await this.#runScript('readFile', [String(path), String(maxBytes)], {
      timeoutMs: FILE_TIMEOUT_MS,
      signal: options.signal,
    })
    if (result.code === 2) {
      throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `"${path}" 不存在或不是普通文件`, {
        operation: 'readFile',
        target: String(path),
        retryable: false,
      })
    }
    if (result.code !== 0) {
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, `readFile 失败（exit ${result.code}）：${result.stderr}`, {
        operation: 'readFile',
        target: String(path),
      })
    }

    const buffer = Buffer.from(decodeUtf8(result.stdout).trim(), 'base64')
    if (buffer.length > maxBytes) {
      throw new TransportError(
        TRANSPORT_ERROR.TOO_LARGE,
        `"${path}" 超过上限 ${maxBytes} 字节（读到 ${buffer.length}）`,
        { operation: 'readFile', target: String(path), retryable: false },
      )
    }

    if (options.encoding === undefined) return buffer
    // 文本读取：拒绝 NUL 与非法 UTF-8（与宿主 fs 的语义一致）
    if (buffer.includes(0)) {
      throw new TransportError(TRANSPORT_ERROR.NOT_TEXT, `"${path}" 含 NUL 字节，不是文本`, {
        operation: 'readFile',
        target: String(path),
        retryable: false,
      })
    }
    return decodeUtf8Strict(buffer, String(path))
  }

  /**
   * **批量读**：一次 `wsl.exe` 调用拉一批文件（镜像首次拉取的主要提速手段）。
   *
   * 2026-10-09 实测：197 个小文件逐个 readFile（哪怕 4 路并发）要 ~6 秒 ——
   * 瓶颈是**每个文件一次 spawn**（wsl.exe 进程创建 ~30ms×197/4）。
   * 批量后每批 ~40 个文件、复用 4 个槽位，~5 次调用解决，实测降到 ~1.5 秒。
   *
   * 这是**可选能力**：镜像层探测到 `transport.readFilesBatch` 存在才走这条路，
   * 不存在（SSH / Docker）就退回「并发逐个 readFile」。协议见 SCRIPTS.readFilesBatch。
   *
   * @param {string[]} paths 要读的绝对远程路径
   * @param {{ maxBytes?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<Map<string, { ok: true, data: Buffer } | { ok: false, error: TransportError }>>}
   *   每个路径一个结果 —— **单个文件失败不拖垮整批**（与逐个读的语义一致）。
   */
  async readFilesBatch(paths, options = {}) {
    throwIfAborted(options.signal, 'readFilesBatch', `(${paths.length} 个文件)`)
    if (paths.length === 0) return new Map()
    const maxBytes = options.maxBytes ?? 32 * 1024 * 1024

    const result = await this.#runScript('readFilesBatch', [String(maxBytes), ...paths.map(String)], {
      timeoutMs: FILE_TIMEOUT_MS,
      signal: options.signal,
    })
    if (result.code !== 0) {
      // 整批失败：调用方会退回逐个读，那里有更细的错误分类
      throw new TransportError(
        TRANSPORT_ERROR.UNKNOWN,
        `readFilesBatch 失败（exit ${result.code}）：${result.stderr}`,
        { operation: 'readFilesBatch', target: this.distro },
      )
    }

    // 解析协议：每文件三段（路径、长度、base64 内容），NUL 分隔
    const fields = splitNul(result.stdout)
    const out = new Map()
    let i = 0
    while (i + 1 < fields.length) {
      const path = fields[i]
      const declared = fields[i + 1]
      i += 2
      if (declared === '-1') {
        // 文件缺失/不可读：给 NOT_FOUND，调用方按单文件错误处理
        out.set(path, { ok: false, error: new TransportError(
          TRANSPORT_ERROR.NOT_FOUND, `"${path}" 不存在或不是普通文件`,
          { operation: 'readFile', target: path, retryable: false },
        ) })
        continue
      }
      const count = Number(declared)
      const body = fields[i]
      i += 1
      if (!Number.isFinite(count) || body === undefined) {
        // 协议错位（不该发生）：当整体失败，交给调用方退回逐个读
        throw new TransportError(
          TRANSPORT_ERROR.UNKNOWN,
          `readFilesBatch 输出协议错位（在 ${path} 附近）`,
          { operation: 'readFilesBatch', target: this.distro, retryable: false },
        )
      }
      const buffer = Buffer.from(body, 'base64')
      if (buffer.length > maxBytes) {
        // head -c max+1 造成的超限：与单个 readFile 的契约一致（失败，不截断）
        out.set(path, { ok: false, error: new TransportError(
          TRANSPORT_ERROR.TOO_LARGE,
          `"${path}" 超过上限 ${maxBytes} 字节（读到 ${buffer.length}）`,
          { operation: 'readFile', target: path, retryable: false },
        ) })
        continue
      }
      out.set(path, { ok: true, data: buffer })
    }
    return out
  }

  /**
   * 原子写：发行版内 `mktemp` 同目录 → 写 → `mv -f`（rename(2)，ext4 上原子）。
   * 内容经 **stdin** 传 base64，避免命令行长度与转义问题。
   */
  async writeFileAtomic(path, data, options = {}) {
    throwIfAborted(options.signal, 'writeFileAtomic', path)
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), options.encoding ?? 'utf8')
    const result = await this.#runScript('writeFileAtomic', [String(path)], {
      timeoutMs: FILE_TIMEOUT_MS,
      signal: options.signal,
      stdin: Buffer.from(buffer.toString('base64'), 'utf8'),
    })
    if (result.code !== 0) {
      const code = result.code === 4 ? TRANSPORT_ERROR.PERMISSION_DENIED : TRANSPORT_ERROR.UNKNOWN
      throw new TransportError(code, `原子写失败（exit ${result.code}）：${result.stderr}`, {
        operation: 'writeFileAtomic',
        target: String(path),
      })
    }
  }

  /**
   * 目标发行版里用哪个 shell —— 探测一次并缓存（**单飞**）。
   *
   * **POSIX shell 才是硬要求，bash 只是常见**。实测：Docker Desktop 的
   * `docker-desktop` 发行版里只有 busybox 的 `sh`，没有 bash —— 写死 `bash -lc`
   * 会让那种发行版直接连不上（用户实测：`execvpe(bash) failed: No such file`）。
   *
   * 优先 bash（`-l` 能拿到登录 shell 的 PATH），拿不到就退到 sh。
   * **两者都没有才报错** —— 不静默降级成一个跑不了命令的假连接。
   *
   * ## 两个必须这么写的理由
   *
   * 1. **单飞**：并发跑 16 个 exec 时，若每个都去探一次，就会同时冒出 16 个
   *    `wsl.exe` —— 而**并发硬限流 4** 是实测底线（8 路以上会把 relay 打到
   *    30 秒级停顿，更激进的突发会把它打死）。所以只探一次，其余等同一个 promise。
   * 2. **调用点必须在 `#acquire()` 之后**：探测本身也是一次 spawn，得占一个槽位，
   *    否则它就成了「超出上限的第 5 个」。
   */
  #resolveShell(timeoutMs) {
    if (this.shell !== undefined) return Promise.resolve(this.shell)
    if (this.shellProbe === undefined) {
      this.shellProbe = this.#probeShell(timeoutMs).catch((error) => {
        // 失败**不缓存** —— 下次还该能重试（比如发行版刚被启动、或者这次预算太小）
        this.shellProbe = undefined
        throw error
      })
    }
    return this.shellProbe
  }

  /** 真正去探一次（由 {@link WslTransport#resolveShell} 保证只跑一次）。 */
  async #probeShell(timeoutMs) {
    for (const candidate of ['bash', 'sh']) {
      try {
        const probe = await this.#spawn([
          '-d', this.distro,
          ...(this.username === undefined ? [] : ['-u', this.username]),
          '-e', candidate, '-c', 'exit 0',
        ], { timeoutMs: timeoutMs ?? this.timeoutMs })
        if (probe.code === 0) {
          this.shell = candidate
          if (candidate !== 'bash') {
            this.log?.('WSL 发行版 %s 里没有 bash，退到 %s', this.distro, candidate)
          }
          return candidate
        }
      } catch (error) {
        // ⚠️ **致命错误与超时必须往上抛**，不能当成「这个 shell 没有」：
        //   - `Wsl/E_DISTRO_NOT_FOUND` / `Wsl/E_ACCESSDENIED` 说的是
        //     「发行版不存在 / 被拒绝」；
        //   - 超时说明发行版**根本没响应**。
        // 把这两种吞掉、改报「既没有 bash 也没有 sh」，就是**谎报原因**，
        // 用户照着这个提示永远查不出来。
        if (error instanceof TransportError && (error.operation === 'wsl' || error.code === TRANSPORT_ERROR.TIMEOUT)) {
          throw error
        }
        // 否则就是这个候选不存在 —— 试下一个
      }
    }
    throw new TransportError(
      TRANSPORT_ERROR.CONNECT_FAILED,
      `发行版 "${this.distro}" 里既没有 bash 也没有 sh —— 没法执行命令`,
      { operation: 'connect', target: this.distro, retryable: false },
    )
  }

  /**
   * 执行命令。
   *
   * 与文件操作不同，这里**必须**经 shell —— 调用方给的就是 shell 命令。
   * 优先 `bash -lc`（登录 shell 能拿到用户的 PATH 等环境）；
   * 发行版里没有 bash 就退到 `sh -c`（见 {@link WslTransport#resolveShell}）。
   */
  async exec(command, options = {}) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('exec: command 不能为空')
    }
    if (command.includes('\0')) {
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, '命令含 NUL 字节', { operation: 'exec' })
    }
    // 已取消就**一个进程都不发**（包括 shell 探测）—— 也顺手不占并发槽位
    throwIfAborted(options.signal, 'exec', command)

    const workdir = options.cwd

    await this.#acquire()
    try {
      // 探测要在**拿到槽位之后** —— 它自己也是一次 spawn（见 #resolveShell 的注释）。
      // 预算用**调用方的**：探测是「兑现这条命令」的一部分，不该偷偷用更长的超时。
      const shell = await this.#resolveShell(options.timeoutMs)
      // 显式 --cd（相对路径会 E_INVALIDARG，所以要求调用方给绝对路径）
      const argv = [
        '-d', this.distro,
        ...(this.username === undefined ? [] : ['-u', this.username]),
        ...(workdir === undefined ? [] : ['--cd', String(workdir)]),
        '-e', shell,
        ...(shell === 'bash' ? ['-lc', command] : ['-c', command]),
      ]
      const result = await this.#spawn(argv, {
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        signal: options.signal,
      })
      const stdout = decodeUtf8(result.stdout)
      const stderr = result.stderr
      options.onStdout?.(Buffer.from(stdout, 'utf8'))
      options.onStderr?.(Buffer.from(stderr, 'utf8'))
      return { code: result.code, stdout, stderr }
    } finally {
      this.#release()
    }
  }
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 把 `wslExe`（字符串或前缀数组）+ argv 拆成 `execFile` 要的 `(command, args)`。
 *
 * 字符串形态就是直接调 `wsl.exe`；数组形态用于注入（测试/包装脚本）。
 */
export function splitWslCommand(wslExe, argv) {
  if (Array.isArray(wslExe)) {
    if (wslExe.length === 0) throw new Error('wslExe 数组不能为空')
    const [command, ...prefix] = wslExe
    return { command, args: [...prefix, ...argv] }
  }
  return { command: wslExe, args: argv }
}

/**
 * 枚举发行版。
 *
 * `wsl -l -q` 的输出是 **UTF-16LE 无 BOM**，且名字之间有空行（实测），
 * 所以要按 utf16le 解码并过滤空行。
 *
 * @param {{ wslExe?: string|string[] }} [options]
 */
export async function listDistros(options = {}) {
  const { command, args } = splitWslCommand(options.wslExe ?? 'wsl.exe', ['-l', '-q'])
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'buffer',
    }, (error, stdout) => {
      if (error !== null && error !== undefined && Number(error.code) !== 0) {
        reject(new TransportError(
          TRANSPORT_ERROR.CONNECT_FAILED,
          `枚举 WSL 发行版失败：${error.message}`,
          { operation: 'listDistros' },
        ))
        return
      }
      const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''))
      const text = decodeWslOutput(buffer)
      resolve(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ''))
    })
  })
}

/** 按 UTF-16LE 解码 `wsl.exe` 自己的输出（无 BOM）。 */
export function decodeWslOutput(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''))
  if (buf.length === 0) return ''
  // BOM 检查：FF FE → UTF-16LE；FE FF → UTF-16BE（少见但存在）
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  // 无 BOM：靠「每隔一个字节是 0」判断是不是 UTF-16LE（ASCII 内容的典型特征）
  const sample = buf.subarray(0, Math.min(buf.length, 64))
  let zeroOdd = 0
  for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) zeroOdd += 1
  const pairs = Math.floor(sample.length / 2)
  if (pairs > 0 && zeroOdd / pairs > 0.8) return buf.toString('utf16le')
  return buf.toString('utf8')
}

/** `wsl.exe` 的错误输出也可能是 UTF-16LE。 */
function decodeWslError(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''))
  if (buf.length === 0) return ''
  const sample = buf.subarray(0, Math.min(buf.length, 64))
  let zeroOdd = 0
  for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) zeroOdd += 1
  const pairs = Math.floor(sample.length / 2)
  return pairs > 0 && zeroOdd / pairs > 0.8 ? buf.toString('utf16le') : buf.toString('utf8')
}

/** UTF-8 解码（子进程输出就是 UTF-8）。 */
function decodeUtf8(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''))
  return buf.toString('utf8')
}

/** 严格 UTF-8 解码：非法序列报 `NOT_TEXT`（与宿主 fs 语义一致）。 */
function decodeUtf8Strict(buffer, path) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    return decoder.decode(buffer)
  } catch (error) {
    throw new TransportError(TRANSPORT_ERROR.NOT_TEXT, `"${path}" 不是合法 UTF-8 文本`, {
      operation: 'readFile',
      target: path,
      retryable: false,
      cause: error,
    })
  }
}

/** 按 NUL 切分（去掉结尾的空字段）。 */
function splitNul(buffer) {
  const text = decodeUtf8(buffer)
  const parts = text.split('\0')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** `stat --printf %F` 的取值 → 我们的类型。 */
function typeFromStatKind(kind) {
  const value = String(kind ?? '')
  if (value === 'directory') return 'directory'
  if (value === 'regular file' || value === 'regular empty file') return 'file'
  if (value === 'symbolic link') return 'symlink'
  return 'other'
}

/** `find -printf %y` 的取值 → 我们的类型。 */
function typeFromFindKind(kind) {
  switch (String(kind ?? '')) {
    case 'd': return 'directory'
    case 'f': return 'file'
    case 'l': return 'symlink'
    default: return 'other'
  }
}

/** 取消检查：abort 是终态。 */
function throwIfAborted(signal, operation, target) {
  if (signal?.aborted === true) {
    throw new TransportError(TRANSPORT_ERROR.ABORTED, `${operation} 已被取消`, {
      operation,
      target: String(target),
    })
  }
}
