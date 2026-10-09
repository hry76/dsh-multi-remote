/**
 * `src/http/fence.js` 的契约测试。
 *
 * 这一层的失败后果是**本地服务被任意网页打**（参考项目有真实事故：
 * 不校验 Origin 的本地桥接接口 → 任何网页都能建隧道、改机器清单）。
 * 所以每条判据都要有负对照，且必须 fail-closed。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkRequestFence, parseAuthority, parseOrigin, isLoopbackHostname, fence } from '../src/http/fence.js'

/** 造一个只有 headers 的假请求。 */
const req = (headers) => ({ headers })

test('parseAuthority：主机、端口、IPv6 字面量', () => {
  assert.deepEqual(parseAuthority('127.0.0.1:19388'), { hostname: '127.0.0.1', port: '19388' })
  assert.deepEqual(parseAuthority('localhost'), { hostname: 'localhost', port: '' })
  assert.deepEqual(parseAuthority('example.com:443'), { hostname: 'example.com', port: '443' })
  assert.deepEqual(parseAuthority('[::1]:8080'), { hostname: '[::1]', port: '8080' })
  assert.equal(parseAuthority(''), undefined)
  assert.equal(parseAuthority('a:b:c'), undefined, '多个冒号且非 IPv6 字面量 → 非法')
  // 负对照：不做这个判断，`Host: a:b:c` 会被当成合法主机名
})

test('isLoopbackHostname：回环网段与常见别名', () => {
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('127.1.2.3'), true, '整个 127/8 都是回环')
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('::1'), true)
  assert.equal(isLoopbackHostname('example.com'), false)
  assert.equal(isLoopbackHostname('10.0.0.1'), false)
  // 负对照：只认字面量 '127.0.0.1'，127.0.0.2 会被误拒（本地开发会莫名 403）
})

test('parseOrigin：取出 authority 便于与 Host 比较', () => {
  assert.equal(parseOrigin('http://127.0.0.1:19388'), '127.0.0.1:19388')
  assert.equal(parseOrigin('https://example.com'), 'example.com')
  assert.equal(parseOrigin('null'), undefined)
  assert.equal(parseOrigin(''), undefined)
  assert.equal(parseOrigin('不是 URL'), undefined)
  // 负对照：不 catch，畸形 Origin 会把整个请求处理打挂（等于 DoS）
})

test('栅栏：正常回环请求放行', () => {
  assert.deepEqual(checkRequestFence(req({ host: '127.0.0.1:19388' })), { ok: true })
  assert.deepEqual(checkRequestFence(req({ host: 'localhost:8080' })), { ok: true })
  // 无 Origin（curl / 脚本）也放行 —— 浏览器跨站时一定带 Origin
  assert.deepEqual(checkRequestFence(req({ host: '127.0.0.1:19388', origin: 'http://127.0.0.1:19388' })), { ok: true })
  // 负对照：把「无 Origin」也拒掉，所有 CLI 自检都会 403
})

test('栅栏：伪造 Host 一律 403', () => {
  const verdict = checkRequestFence(req({ host: 'evil.example.com' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 403)
  assert.match(verdict.reason, /Host 不可信/)
  // 负对照：不校验 Host，DNS rebinding 就能把请求指到本地服务上
})

test('栅栏：缺 Host 头 → 403（fail-closed）', () => {
  const verdict = checkRequestFence(req({}))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 403)
  // 负对照：Host 缺失时返回 ok，等于对畸形请求 fail-open
})

test('栅栏：跨站 Origin 一律 403', () => {
  const verdict = checkRequestFence(req({ host: '127.0.0.1:19388', origin: 'http://evil.example.com' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 403)
  assert.match(verdict.reason, /不同源/)
  // 负对照：这正是参考项目出事故的形态 —— 任何网页都能打本地接口
})

test('栅栏：Origin 端口不同也算跨源', () => {
  const verdict = checkRequestFence(req({ host: '127.0.0.1:19388', origin: 'http://127.0.0.1:19387' }))
  assert.equal(verdict.ok, false, '同主机不同端口不是同源')
  // 负对照：只比主机名不比端口，另一个本地服务就能打我们
})

test('栅栏：Sec-Fetch-Site: cross-site → 403', () => {
  const verdict = checkRequestFence(req({ host: '127.0.0.1:19388', 'sec-fetch-site': 'cross-site' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 403)
  // 负对照：不看这个头，就只能靠 Origin —— 而某些请求形态下浏览器不带 Origin
})

test('栅栏：畸形 Origin → 403', () => {
  const verdict = checkRequestFence(req({ host: '127.0.0.1:19388', origin: 'null' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 403)
  // 负对照：把 'null' Origin 当成「没有 Origin」放行 —— 沙箱 iframe 会带 null
})

test('栅栏：trustedHosts 显式放行额外主机', () => {
  const request = req({ host: 'dsh.internal:8443', origin: 'https://dsh.internal:8443' })
  assert.equal(checkRequestFence(request).ok, false, '默认不可信')
  assert.equal(checkRequestFence(request, { trustedHosts: ['dsh.internal:8443'] }).ok, true)
  // 负对照：trustedHosts 恒为空，反代场景下会全 403
})

test('fence 包装器：拒绝时不调用 handler，且响应体不泄漏信息', () => {
  let called = false
  const wrapped = fence(() => {
    called = true
  })

  let status
  let body
  const res = {
    writeHead(code) {
      status = code
    },
    end(text) {
      body = text
    },
  }

  wrapped(req({ host: 'evil.example.com' }), res)
  assert.equal(called, false, '被拒时绝不能执行 handler')
  assert.equal(status, 403)
  assert.equal(body, 'forbidden')
  assert.ok(!String(body).includes('evil'), '拒绝响应不该回显请求内容')

  wrapped(req({ host: '127.0.0.1:1' }), res)
  assert.equal(called, true, '放行时要调用 handler')
  // 负对照：先执行 handler 再检查栅栏 —— 副作用已经发生了
})
