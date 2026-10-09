/**
 * 审计日志 —— 记录**远程操作**的发生与结果。
 *
 * ## 为什么要有
 *
 * 远程开发插件会在一台**别的机器**上执行命令、改文件。出问题时用户最需要回答的是：
 *
 *   - 我到底连过哪些机器？什么时候连的？成没成？
 *   - 某条命令是在哪台机器上跑的？
 *   - 这次失败是认证问题、网络问题，还是权限问题？
 *
 * 宿主自己的 logger 只按「插件内部发生了什么」记，回答不了上面这些。
 * 所以这里专门记一份**面向操作**的轨迹。
 *
 * ## 三条设计约束
 *
 * 1. **有界**：环形缓冲（默认 500 条）。审计日志绝不能成为内存泄漏的来源。
 * 2. **绝不落凭据**：写入前统一过一遍脱敏（见 `redact`），且**只记结构化字段**
 *    —— 不把整个 profile 对象塞进去，从源头减少泄漏面。
 * 3. **绝不影响主流程**：记录失败（哪怕是被写坏了）不能让连接失败。
 *    所以 `record()` 内部全部 try/catch，且**永不抛错**。
 *
 * ## 不写文件
 *
 * 刻意只放内存：写文件要处理轮转、权限、并发，而审计日志一旦写坏就是
 * 又一个「静默失败」。当前阶段内存环形缓冲 + 自检路由暴露已经够用，
 * 需要持久化时再单独设计（那是另一个决策）。
 */

/** 默认保留多少条。 */
export const DEFAULT_AUDIT_CAPACITY = 500

/**
 * 会被脱敏的字段名（大小写不敏感）。
 *
 * ⚠️ 刻意**不**匹配 `...Path` 结尾的名字：`privateKeyPath` 只是**路径**，
 * 不是凭据 —— 而且它是排查「为什么认证失败」时最有用的信息之一。
 * 一刀切按 `key` 结尾匹配会把 `privateKeyPath` 也抹掉，反而损害可用性。
 */
const SENSITIVE_KEY_PATTERN =
  /^(?:pass(?:word|phrase)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth(?:orization)?|cookie)$/i

/** 结尾是这些词的也当凭据（但排除 `...Path` / `...File` 这类「只是位置」的名字）。 */
const SENSITIVE_SUFFIX_PATTERN = /(?:password|passphrase|secret|token)$/i
const LOCATION_SUFFIX_PATTERN = /(?:path|file|dir|directory|url|id|name)$/i

/**
 * 递归脱敏一个值。
 *
 * 两道防线：
 *   1. **按字段名**：名字像凭据的，值一律换成 `'***'`（不记长度，避免侧信道）。
 *   2. **按内容**：字符串里出现私钥/口令样式的片段也要抹掉。
 *
 * 第二道是必要的 —— 错误信息里经常夹带原始输入（例如「认证失败：password=xxx」）。
 *
 * @param {unknown} value
 * @param {number} [depth] 防环
 * @returns {unknown}
 */
export function redact(value, depth = 0) {
  if (depth > 6) return '[深度过深]'
  if (value === null || value === undefined) return value

  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function') return '[函数]'
  if (typeof value === 'symbol') return String(value)

  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1))

  if (value instanceof Error) {
    return { name: value.name, message: redactText(String(value.message)), code: value.code ?? undefined }
  }
  if (value instanceof Map) {
    return redact(Object.fromEntries([...value.entries()].slice(0, 50)), depth + 1)
  }
  if (value instanceof Set) {
    return redact([...value.values()].slice(0, 50), depth + 1)
  }

  if (typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value).slice(0, 50)) {
      out[key] = isSensitiveKey(key) ? '***' : redact(entry, depth + 1)
    }
    return out
  }

  return String(value)
}

/** 判断一个字段名是不是凭据。 */
function isSensitiveKey(key) {
  const name = String(key)
  if (SENSITIVE_KEY_PATTERN.test(name)) return true
  // 结尾像凭据，但「位置类」的名字（path / file / url / id …）放行
  if (SENSITIVE_SUFFIX_PATTERN.test(name) && !LOCATION_SUFFIX_PATTERN.test(name)) return true
  return false
}

/** 抹掉文本里像凭据的片段。 */
function redactText(text) {
  let out = String(text)
  // `password=xxx` / `passphrase: "my phrase"` / `token abc` 这类。
  // 带引号的值要整体吃掉 —— 只吃到第一个空格会留下后半段（实测踩到）。
  out = out.replace(
    /((?:pass(?:word|phrase)?|secret|token|api[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    '$1***',
  )
  // 私钥正文
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[私钥已脱敏]')
  return out
}

/**
 * 有界审计日志。
 *
 * 用法：`audit.record('connect', { profileId, kind, ok })`。
 */
export class AuditLog {
  /**
   * @param {{ capacity?: number, now?: () => number }} [options]
   */
  constructor(options = {}) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_AUDIT_CAPACITY)
    this.now = options.now ?? (() => Date.now())
    /** @type {Array<{ seq: number, at: string, event: string, detail: object }>} */
    this.entries = []
    this.seq = 0
    /** 因为超界被丢掉了多少条（如实记账）。 */
    this.dropped = 0
  }

  /**
   * 记一条。
   *
   * **永不抛错** —— 审计日志坏了不该让连接失败。
   *
   * @param {string} event 事件名（`connect` / `disconnect` / `connect-failed` / …）
   * @param {Record<string, unknown>} [detail] 结构化细节（会被脱敏）
   * @returns {object|undefined} 记下来的那一条（便于测试）；失败时 undefined
   */
  record(event, detail = {}) {
    try {
      this.seq += 1
      const entry = {
        seq: this.seq,
        at: new Date(this.now()).toISOString(),
        event: String(event),
        detail: redact(detail),
      }
      this.entries.push(entry)
      if (this.entries.length > this.capacity) {
        const excess = this.entries.length - this.capacity
        this.entries.splice(0, excess)
        this.dropped += excess
      }
      return entry
    } catch {
      // 审计日志自己出问题，绝不上抛
      return undefined
    }
  }

  /**
   * 读最近若干条（新的在后）。
   *
   * @param {{ limit?: number, event?: string }} [request]
   */
  read(request = {}) {
    let rows = this.entries
    if (typeof request.event === 'string' && request.event !== '') {
      rows = rows.filter((entry) => entry.event === request.event)
    }
    const limit = Math.max(1, Math.min(request.limit ?? 50, this.capacity))
    return {
      entries: rows.slice(-limit),
      total: rows.length,
      // 丢过就说丢了 —— 别让用户以为看到的是全部历史
      dropped: this.dropped,
      capacity: this.capacity,
    }
  }

  /** 清空（自检里可用来重置）。 */
  clear() {
    const cleared = this.entries.length
    this.entries = []
    this.dropped = 0
    return cleared
  }
}
