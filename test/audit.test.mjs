/**
 * `src/audit.js` 的契约测试。
 *
 * 审计日志的价值全在**三条约束**上，所以测试也围着它们：
 *   1. **有界** —— 绝不能变成内存泄漏
 *   2. **绝不落凭据** —— 这是硬红线
 *   3. **绝不影响主流程** —— 记录失败不能让连接失败
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AuditLog, redact, DEFAULT_AUDIT_CAPACITY } from '../src/audit.js'

// ── 脱敏（硬红线）────────────────────────────────────────────────────────────

test('redact：字段名像凭据的一律抹掉', () => {
  const out = redact({
    username: 'user',
    password: 'hunter2',
    passphrase: 'secret-phrase',
    privateKey: 'KEYDATA',
    privateKeyPath: '/home/user/.ssh/id_ed25519',
    token: 'tok_abc',
    apiKey: 'sk-xyz',
    secret: 'shh',
    host: 'example.com',
  })

  assert.equal(out.username, 'user', '普通字段照常保留')
  assert.equal(out.host, 'example.com')
  for (const key of ['password', 'passphrase', 'privateKey', 'token', 'apiKey', 'secret']) {
    assert.equal(out[key], '***', `${key} 必须被抹掉`)
  }
  // `privateKeyPath` 不是凭据（只是路径），按「key$」规则它**不该**被抹 —— 它有用
  assert.equal(out.privateKeyPath, '/home/user/.ssh/id_ed25519')
  // 负对照：不脱敏 → 审计日志成了凭据仓库，比不记还坏
})

test('redact：字符串里的凭据片段也要抹掉（错误信息经常夹带）', () => {
  assert.equal(redact('auth failed: password=hunter2'), 'auth failed: password=***')
  assert.equal(redact('passphrase: "my phrase"'), 'passphrase: ***')
  assert.equal(redact('token=abc123 retry'), 'token=*** retry')
  assert.equal(redact('api_key: sk-live-xxx'), 'api_key: ***')
  // 负对照：只按字段名脱敏 → 服务端把口令回显在错误里就漏出去了
})

test('redact：私钥正文被整段替换', () => {
  const text = 'load failed:\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----\ndone'
  const out = redact(text)
  assert.ok(!out.includes('AAAA'), '私钥正文不能留下')
  assert.ok(!out.includes('BEGIN OPENSSH'), '连头尾也不该留')
  assert.match(out, /私钥已脱敏/)
  // 负对照：不处理多行私钥 → 整把私钥进日志
})

test('redact：嵌套结构、数组、Error、Map/Set 都能处理', () => {
  const error = Object.assign(new Error('password=leaked'), { code: 'TRANSPORT_AUTH_FAILED' })
  const out = redact({
    nested: { password: 'x', keep: 1 },
    list: [{ token: 'y' }, 'plain'],
    error,
    map: new Map([['password', 'z']]),
    set: new Set(['a']),
  })

  assert.equal(out.nested.password, '***')
  assert.equal(out.nested.keep, 1)
  assert.equal(out.list[0].token, '***')
  assert.equal(out.list[1], 'plain')
  assert.equal(out.error.name, 'Error')
  assert.equal(out.error.code, 'TRANSPORT_AUTH_FAILED')
  assert.ok(!JSON.stringify(out).includes('leaked'), '错误信息里的口令也要抹掉')
  // 负对照：只处理顶层 → 嵌套一层的凭据就漏了
})

test('redact：循环引用不会栈溢出', () => {
  const cyclic = { name: 'a' }
  cyclic.self = cyclic
  assert.doesNotThrow(() => redact(cyclic))
  // 负对照：无深度上限 → 循环结构直接爆栈，审计日志变成崩溃源
})

// ── 有界 ────────────────────────────────────────────────────────────────────

test('AuditLog：超过容量丢最老的，并如实记账', () => {
  const audit = new AuditLog({ capacity: 3 })
  for (let i = 1; i <= 10; i += 1) audit.record('e', { i })

  const page = audit.read({ limit: 100 })
  assert.equal(page.entries.length, 3, '只保留容量内的条数')
  assert.deepEqual(page.entries.map((entry) => entry.detail.i), [8, 9, 10], '保留最新的')
  assert.equal(page.dropped, 7, '丢了多少条必须记账')
  assert.equal(page.capacity, 3)
  // 负对照：无界 → 长时间运行后内存一直涨（审计日志绝不能是泄漏源）
})

test('AuditLog：read 的 limit 与 event 过滤生效', () => {
  const audit = new AuditLog({ capacity: 100 })
  audit.record('connect-ok', { a: 1 })
  audit.record('connect-failed', { a: 2 })
  audit.record('connect-ok', { a: 3 })

  assert.equal(audit.read({ limit: 2 }).entries.length, 2, 'limit 生效')
  assert.equal(audit.read().total, 3)

  const onlyFailed = audit.read({ event: 'connect-failed' })
  assert.equal(onlyFailed.total, 1)
  assert.equal(onlyFailed.entries[0].detail.a, 2)
  // 负对照：event 过滤不生效 → 排查时得自己翻全部
})

test('AuditLog：序号单调递增，时间戳是 ISO 字符串', () => {
  const audit = new AuditLog({ capacity: 10, now: () => 1_700_000_000_000 })
  const first = audit.record('a')
  const second = audit.record('b')
  assert.equal(first.seq, 1)
  assert.equal(second.seq, 2)
  assert.equal(first.at, new Date(1_700_000_000_000).toISOString())
  // 负对照：序号复用 → 分不清先后
})

test('AuditLog：clear 清空并返回清掉多少条', () => {
  const audit = new AuditLog({ capacity: 10 })
  audit.record('a')
  audit.record('b')
  assert.equal(audit.clear(), 2)
  assert.equal(audit.read().total, 0)
  assert.equal(audit.read().dropped, 0)
  // 负对照：clear 不清 dropped → 清空后还显示「丢过 N 条」，误导
})

// ── 绝不影响主流程 ──────────────────────────────────────────────────────────

test('AuditLog：记录本身出问题时**不抛错**（审计坏了不能让连接失败）', () => {
  const audit = new AuditLog({ capacity: 10 })
  // 造一个会抛错的 detail：getter 抛
  const hostile = {
    get boom() {
      throw new Error('getter 炸了')
    },
  }
  assert.doesNotThrow(() => audit.record('x', hostile))
  assert.equal(audit.record('y').event, 'y', '后面还能继续记')
  // 负对照：不 try/catch → 审计日志的一个 bug 会让所有连接失败
})

test('AuditLog：容量非法时收敛到至少 1，不崩', () => {
  assert.equal(new AuditLog({ capacity: 0 }).capacity, 1)
  assert.equal(new AuditLog({ capacity: -5 }).capacity, 1)
  assert.equal(new AuditLog().capacity, DEFAULT_AUDIT_CAPACITY)
  // 负对照：capacity=0 → 每次 record 都 splice 到负数，数组行为诡异
})

test('默认容量是有界的（不能是 Infinity）', () => {
  assert.ok(Number.isFinite(DEFAULT_AUDIT_CAPACITY))
  assert.ok(DEFAULT_AUDIT_CAPACITY > 0 && DEFAULT_AUDIT_CAPACITY <= 10_000)
  // 负对照：默认无限 → 长时间运行必然涨内存
})
