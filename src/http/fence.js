/**
 * HTTP 路由栅栏 —— Host / Origin / Sec-Fetch-Site 校验，**fail-closed**。
 *
 * ## 为什么必须有（不是形式主义）
 *
 * DSH 的 web server 监听 `127.0.0.1`。浏览器里的**任意网页**都能向
 * `http://127.0.0.1:<port>/...` 发请求 —— 这就是所谓的「本地服务被跨站打」。
 * 参考项目里有真实事故：某个本地桥接接口不校验 Origin，导致**任何网页都能
 * 建隧道、改机器清单**，等于把远程执行能力开放给了互联网。
 *
 * ## 我们和宿主 `/api` 的关系
 *
 * 宿主的 `/api` 前缀有自己的栅栏（Host 必须回环或受信任 + Origin 同源 + cookie 认证）。
 * 但**我们自己的路由不在那个前缀下**，宿主不会替我们挡。所以要自己挡。
 *
 * ## 默认策略（fail-closed）
 *
 *   1. `Host` 必须是回环地址，或在显式配置的 `trustedHosts` 里 —— 否则 403。
 *   2. `Sec-Fetch-Site: cross-site` 一律 403。
 *   3. `Origin` 存在时，其 host 必须与 `Host` 相同 —— 否则 403。
 *   4. 没有 `Origin` 的请求（curl、脚本、同进程）放行 —— 浏览器对简单 GET
 *      一定带 `Origin`（跨站时）或不带（同源导航），所以这条不会削弱防护。
 *
 * 注：即使栅栏被绕过，浏览器也**读不到**响应 —— 我们从不发 `Access-Control-Allow-Origin`。
 * 这是第二道保险；栅栏是第一道。
 */

/** 回环主机名。 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', 'localhost', '[::1]'])

/**
 * 解析 `Host` / `Origin` 里的 authority，取出主机名与端口。
 *
 * 刻意手写而不用 `new URL()`：`Host` 头是裸 authority（没有 scheme），
 * 塞给 URL 会抛错。这里只需要主机名，手写解析更直接也更可控。
 *
 * @param {string} authority
 * @returns {{ hostname: string, port: string }|undefined}
 */
export function parseAuthority(authority) {
  const value = String(authority ?? '').trim()
  if (value === '') return undefined

  // IPv6 字面量：[::1]:8080
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close === -1) return undefined
    const hostname = value.slice(0, close + 1)
    const rest = value.slice(close + 1)
    if (rest === '') return { hostname, port: '' }
    if (!rest.startsWith(':')) return undefined
    return { hostname, port: rest.slice(1) }
  }

  const lastColon = value.lastIndexOf(':')
  if (lastColon === -1) return { hostname: value, port: '' }
  // 有多个冒号但不是 IPv6 字面量 → 非法
  if (value.indexOf(':') !== lastColon) return undefined
  return { hostname: value.slice(0, lastColon), port: value.slice(lastColon + 1) }
}

/** 主机名是否是回环。 */
export function isLoopbackHostname(hostname) {
  const value = String(hostname ?? '').toLowerCase()
  if (LOOPBACK_HOSTNAMES.has(value)) return true
  // 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true
  return false
}

/**
 * 判定一个请求是否可信。
 *
 * @param {{ headers?: Record<string, unknown> }} req node:http 的请求
 * @param {{ trustedHosts?: string[] }} [options] 额外受信任的 authority（例如反代域名）
 * @returns {{ ok: true } | { ok: false, status: number, reason: string }}
 */
export function checkRequestFence(req, options = {}) {
  const headers = req?.headers ?? {}
  const trustedHosts = new Set((options.trustedHosts ?? []).map((entry) => String(entry).toLowerCase()))

  const hostHeader = headers.host
  const authority = parseAuthority(hostHeader)
  if (authority === undefined) {
    return { ok: false, status: 403, reason: 'Host 头缺失或非法' }
  }
  const hostLower = String(hostHeader).toLowerCase()
  if (!isLoopbackHostname(authority.hostname) && !trustedHosts.has(hostLower)) {
    return { ok: false, status: 403, reason: `Host 不可信：${hostHeader}` }
  }

  // 跨站请求一律拒绝
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
    return { ok: false, status: 403, reason: 'Sec-Fetch-Site: cross-site' }
  }

  const origin = headers.origin
  if (origin !== undefined && String(origin) !== '') {
    const parsed = parseOrigin(origin)
    if (parsed === undefined) {
      return { ok: false, status: 403, reason: `Origin 非法：${origin}` }
    }
    // Origin 的 authority 必须与 Host 一致（含端口）
    if (parsed !== hostLower) {
      return { ok: false, status: 403, reason: `Origin 与 Host 不同源：${origin}` }
    }
  }

  return { ok: true }
}

/**
 * 从 `Origin` 里取出 authority（host:port），便于与 `Host` 直接比较。
 *
 * @param {string} origin
 * @returns {string|undefined}
 */
export function parseOrigin(origin) {
  const value = String(origin ?? '').trim()
  if (value === '' || value === 'null') return undefined
  try {
    const url = new URL(value)
    return url.host.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * 一个「先过栅栏、再交给 handler」的包装器。
 *
 * 用法：
 * ```js
 * ctx.webServer.register({
 *   kind: 'exact',
 *   path: '/x',
 *   handler: fence((req, res) => { ... }),
 * })
 * ```
 *
 * @param {(req: object, res: object) => unknown} handler
 * @param {{ trustedHosts?: string[] }} [options]
 * @returns {(req: object, res: object) => unknown}
 */
export function fence(handler, options = {}) {
  return (req, res) => {
    const verdict = checkRequestFence(req, options)
    if (!verdict.ok) {
      // fail-closed：拒绝时明确说明原因，且**不回显任何配置信息**
      res.writeHead(verdict.status, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    return handler(req, res)
  }
}
