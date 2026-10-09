/**
 * 远程 shell 结果的**类型契约**测试。
 *
 * ## 为什么单独立一个文件
 *
 * 2026-10-07 真机事故：用户连上 WSL 后，**`bash` 完全用不了** ——
 * 每次调用都报：
 *
 *     Error: tool "bash" returned invalid output: value is not lossless JSON
 *
 * 根因：宿主 `tool-bash` 组装输出时直接取 `result.exitCode` / `result.signal`，
 * 而 `buildResult()` 里 `signal` **从来没被赋过值**（永远 `undefined`）、
 * `exitCode` 在超时/取消路径也被设成 `undefined`；
 * 宿主的 lossless-JSON 校验**遇到 `undefined` 就把整条结果判为非法**。
 *
 * 这类 bug 的可怕之处：不报「字段缺失」，只报一句「不是合法 JSON」，
 * 而模型那边表现就是「命令跑不了」，完全指不到真正的原因。
 * 所以这里把「结果必须是 lossless JSON」钉成契约。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RemoteShellProcess } from '../src/world/shell.js'

/**
 * 复刻宿主的 lossless-JSON 判据：`undefined` / 函数 / symbol /
 * 非有限数 / 非普通对象，**任意一处出现即整条非法**。
 */
function assertLosslessJson(value, path = '$') {
  if (value === null) return
  const type = typeof value
  if (type === 'string' || type === 'boolean') return
  if (type === 'number') {
    assert.ok(Number.isFinite(value), `${path} 不是有限数：${String(value)}`)
    return
  }
  assert.notEqual(type, 'undefined', `${path} 是 undefined —— 宿主会整条拒绝`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLosslessJson(item, `${path}[${index}]`))
    return
  }
  assert.equal(type, 'object', `${path} 的类型不支持：${type}`)
  const proto = Object.getPrototypeOf(value)
  assert.ok(proto === Object.prototype || proto === null, `${path} 不是普通对象`)
  for (const [key, item] of Object.entries(value)) assertLosslessJson(item, `${path}.${key}`)
}

/** 造一个不需要真传输的进程对象（只测结果形状，不测执行）。 */
function makeProcess(overrides = {}) {
  const proc = new RemoteShellProcess({
    command: 'echo hi',
    workdir: '/',
    timeoutMs: 30_000,
    armed: true,
    stdoutMaxBytes: 4096,
    transport: {},
  })
  Object.assign(proc, overrides)
  return proc
}

test('shell 结果必须是 lossless JSON（`signal` 是 null，不是 undefined）', () => {
  const result = makeProcess().buildResult()

  // 先钉死这两个**踩过坑**的字段
  assert.equal(result.signal, null, 'signal 必须是 null —— undefined 会让宿主整条拒绝')
  assert.equal(result.exitCode, null, '未结算时 exitCode 必须是 null')
  assert.equal(result.timedOut, false)
  assert.equal(result.aborted, false)

  assertLosslessJson(result)
  // 负对照：`signal: undefined` → `tool "bash" returned invalid output:
  //           value is not lossless JSON`，远程会话里 bash 完全不能用
})

test('shell 结果：正常退出、超时、取消三种结算都要合法', () => {
  const normal = makeProcess({ exitCode: 0, stdoutText: 'hi\n' }).buildResult()
  assert.equal(normal.exitCode, 0)
  assert.equal(normal.signal, null)
  assertLosslessJson(normal)

  const timedOut = makeProcess({ exitCode: undefined, timedOut: true }).buildResult()
  assert.equal(timedOut.exitCode, null, '超时路径的 exitCode 也必须归一成 null')
  assert.equal(timedOut.timedOut, true)
  assertLosslessJson(timedOut)

  const aborted = makeProcess({ exitCode: undefined, aborted: true }).buildResult()
  assert.equal(aborted.exitCode, null)
  assert.equal(aborted.aborted, true)
  assertLosslessJson(aborted)
  // 负对照：超时/取消时 `exitCode: undefined` → 同样是「不是合法 JSON」
})

test('shell 结果：被信号杀死时如实报告信号名（拿不到就给 null，不编）', () => {
  const killed = makeProcess({ exitCode: undefined, exitSignal: 'SIGKILL' }).buildResult()
  assert.equal(killed.signal, 'SIGKILL', '拿得到就如实报')
  assert.equal(killed.exitCode, null)
  assertLosslessJson(killed)

  // 传输层不报告信号时 —— 给 null，而不是编一个名字
  const unknown = makeProcess({ exitCode: 137, exitSignal: undefined }).buildResult()
  assert.equal(unknown.signal, null)
  // 负对照：拿不到却填 'SIGKILL' → 审计与界面里出现假信息
})

test('shell 结果：输出被截断时也要合法，且如实标 truncated', () => {
  const big = makeProcess({ exitCode: 0, stdoutText: 'x'.repeat(10_000), stdoutMaxBytes: 100 }).buildResult()
  assert.equal(big.stdout.truncated, true)
  assert.ok(big.stdout.text.length < 10_000)
  assertLosslessJson(big)
  // 负对照：截断后 text 变 undefined → 又是一条「不是合法 JSON」
})
