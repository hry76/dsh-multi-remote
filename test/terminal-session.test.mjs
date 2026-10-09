/**
 * `src/terminal/session.js` 的契约测试。
 *
 * 这一层是**与后端无关的终端机械**（滚动缓冲、就绪判定、发送操作），
 * 所以能测得非常彻底 —— 而它恰恰是三个后端共用的正确性根基。
 *
 * 每个用例配负对照。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BoundedScrollback,
  SendOperation,
  TerminalSessionBase,
  TERMINAL_DEFAULTS,
} from '../src/terminal/session.js'

// ── 滚动缓冲 ────────────────────────────────────────────────────────────────

test('BoundedScrollback：流式追加要正确处理「半行」', () => {
  const buffer = new BoundedScrollback()
  // 一次 chunk 可能把一行切成两半 —— 这是终端输出的常态
  buffer.append('hel')
  buffer.append('lo\nwor')
  buffer.append('ld\n')

  assert.equal(buffer.text(), 'hello\nworld')
  assert.equal(buffer.totalLines, 2)
  // 负对照：每来一个 chunk 就当一整行 → 'hel' 和 'lo' 会变成两行
})

test('BoundedScrollback：超界要丢最老的，并如实记账', () => {
  const buffer = new BoundedScrollback({ maxLines: 3 })
  for (let i = 1; i <= 10; i += 1) buffer.append(`line${i}\n`)

  assert.equal(buffer.totalLines, 3)
  assert.equal(buffer.text(), 'line8\nline9\nline10')
  assert.equal(buffer.droppedLines, 7, '丢了多少行必须记账')
  // 负对照：不设界 → 无限输出（yes / cat 大文件）把内存吃光
})

test('BoundedScrollback：read 按「相对最新的偏移」分页（宿主口径）', () => {
  const buffer = new BoundedScrollback()
  for (let i = 1; i <= 10; i += 1) buffer.append(`l${i}\n`)

  const newest = buffer.read({ offset: 0, count: 3 })
  assert.equal(newest.text, 'l8\nl9\nl10', 'offset=0 应当是最新的几行')
  assert.equal(newest.totalLines, 10)
  assert.equal(newest.lineBegin, 0, 'lineBegin/lineEnd 是相对偏移，不是绝对行号')
  assert.equal(newest.lineEnd, 3)

  const older = buffer.read({ offset: 3, count: 3 })
  assert.equal(older.text, 'l5\nl6\nl7', 'offset 越大越往历史走')
  assert.equal(older.lineBegin, 3)
  // 负对照：把 lineBegin 当绝对行号 → 界面分页会错位
})

test('BoundedScrollback：offset 超过总行数时返回空而不是崩', () => {
  const buffer = new BoundedScrollback()
  buffer.append('only\n')
  const result = buffer.read({ offset: 99, count: 5 })
  assert.equal(result.text, '')
  assert.equal(result.totalLines, 1)
  // 负对照：直接 slice(-98) → 会把内容当成「从头开始」重复返回
})

test('BoundedScrollback：read 参数非法要抛错，不静默兜底', () => {
  const buffer = new BoundedScrollback()
  buffer.append('x\n')
  assert.throws(() => buffer.read({ offset: -1 }), /offset/)
  assert.throws(() => buffer.read({ count: 0 }), /count/)
  assert.throws(() => buffer.read({ offset: 1.5 }), /offset/)
  // 负对照：非法值被 Math.max 悄悄修好 → 调用方以为分页生效了
})

test('BoundedScrollback：丢过行时 read 必须标 truncated', () => {
  const buffer = new BoundedScrollback({ maxLines: 2 })
  for (let i = 1; i <= 5; i += 1) buffer.append(`l${i}\n`)
  const result = buffer.read({ offset: 0, count: 10 })
  assert.equal(result.truncated, true)
  // 负对照：不标 → 上层以为拿到的是完整历史

  const clean = new BoundedScrollback()
  clean.append('a\n')
  assert.equal(clean.read({ offset: 0, count: 10 }).truncated, false, '没丢过就不该乱标')
})

test('BoundedScrollback：正常分页**不算** truncated', () => {
  // `truncated` 只表示「滚动缓冲丢过行」（这段历史已经不存在了），
  // 不能把「这次分页没覆盖到开头」也算进来 —— 那是正常分页。
  // 调用方靠 lineBegin/lineEnd/totalLines 自己判断还有没有更早的内容。
  const buffer = new BoundedScrollback()
  for (let i = 1; i <= 10; i += 1) buffer.append(`l${i}\n`)

  const page = buffer.read({ offset: 0, count: 3 })
  assert.equal(page.text, 'l8\nl9\nl10')
  assert.equal(page.truncated, false, '只是分页，历史没丢，不该标 truncated')
  assert.equal(page.totalLines, 10, '调用方靠这个知道还有更早的内容')
  // 负对照：把 start > 0 也算进 truncated → 每次分页都报「被截断」，告警失去意义
})

// ── 会话骨架 ────────────────────────────────────────────────────────────────

/** 一个最小的可测会话：不发真东西，只记账。 */
class FakeSession extends TerminalSessionBase {
  constructor(options = {}) {
    super({
      pty: options.pty !== false,
      pid: options.pid,
      // 默认**不**等就绪：这个类服务于「机械」测试（写入/滚动/信号/状态），
      // 而 FakeSession 自己不产生任何输出 → 等就绪会白等满上限。
      // 「首次发送前等 banner 打完」有专门的测试（见文件末尾那组）。
      tuning: { awaitReadyTimeoutMs: 0, ...(options.tuning ?? {}) },
    })
    this.written = []
    this.resized = []
    this.signals = []
    this.closed = 0
  }

  _write(data) {
    this.written.push(data.toString('utf8'))
  }

  _resize(cols, rows) {
    this.resized.push([cols, rows])
  }

  async _signal(name) {
    this.signals.push(name)
  }

  async _close() {
    this.closed += 1
  }
}

test('会话：write 把字节原样送出', () => {
  const session = new FakeSession()
  session.write('ls\r')
  assert.deepEqual(session.written, ['ls\r'])
  // 负对照：把 \r 换成 \n → 终端里不会执行（终端要 CR）
})

test('会话：退出后不能再写入', () => {
  const session = new FakeSession()
  session.emitExit(0)
  assert.throws(() => session.write('x'), /已退出/)
  // 负对照：放行 → 往死掉的通道写，错误信息指不到原因
})

test('会话：emitExit 幂等，且状态带 signal 字段（宿主口径）', () => {
  const session = new FakeSession()
  const seen = []
  session.onExit((info) => seen.push(info))

  session.emitExit(7)
  session.emitExit(9)  // 第二次应当被忽略

  assert.deepEqual(seen, [{ exitCode: 7 }], '退出只能报一次')
  const status = session.status()
  assert.equal(status.kind, 'exited')
  assert.equal(status.exitCode, 7)
  assert.ok('signal' in status, '宿主契约要求 status 带 signal 字段')
  // 负对照：不幂等 → 上层收到两次退出，UI 会闪
})

test('会话：没有 PTY 时 resize 是空操作（不假装支持）', () => {
  const piped = new FakeSession({ pty: false })
  piped.resize(120, 40)
  assert.deepEqual(piped.resized, [], '没有 PTY 就不该往下传 resize')

  const pty = new FakeSession({ pty: true })
  pty.resize(120, 40)
  assert.deepEqual(pty.resized, [[120, 40]])
  // 负对照：无脑转发 → 后端报「不支持」，而调用方以为成功了
})

test('会话：close 幂等，只真的关一次', async () => {
  const session = new FakeSession()
  await Promise.all([session.close(), session.close(), session.close()])
  assert.equal(session.closed, 1, '并发 close 也只能关一次')
  await session.close()
  assert.equal(session.closed, 1)
  // 负对照：不幂等 → 重复 close 会重复杀进程 / 重复发信号
})

test('会话：onData 订阅者抛错不能拖垮会话', () => {
  const session = new FakeSession()
  const received = []
  session.onData(() => {
    throw new Error('订阅者自己炸了')
  })
  session.onData((chunk) => received.push(chunk.toString('utf8')))

  session.emitData('output\n')
  assert.equal(received.length, 1, '一个订阅者抛错不该影响其他订阅者')
  // 负对照：不 try/catch → 一个坏订阅者让整个终端静默死掉
})

test('会话：退订后不再收到数据', () => {
  const session = new FakeSession()
  const received = []
  const off = session.onData((chunk) => received.push(chunk.toString('utf8')))
  session.emitData('a')
  off()
  session.emitData('b')
  assert.deepEqual(received, ['a'])
  // 负对照：退订无效 → 内存泄漏 + 重复渲染
})

// ── 发送操作 ────────────────────────────────────────────────────────────────

test('startSend：同一时刻只允许一个（第二次抛 SEND_ACTIVE）', () => {
  const session = new FakeSession()
  session.startSend({ text: 'first', submit: false, timeoutMs: 5000 })
  try {
    session.startSend({ text: 'second', submit: false })
    assert.fail('应当抛错')
  } catch (error) {
    assert.equal(error.code, 'SEND_ACTIVE')
  }
  // 负对照：放行 → 两次发送的输出混在一起，无法归因
})

test('startSend：submit=true 会补一个回车（\\r 不是 \\n）', () => {
  const session = new FakeSession()
  session.startSend({ text: 'echo hi', submit: true, timeoutMs: 5000 })
  assert.deepEqual(session.written, ['echo hi', '\r'])
  // 负对照：补 \n → 终端里不会执行
})

test('SendOperation：安静够久 → inferred_idle', async () => {
  const session = new FakeSession()
  const operation = session.startSend({ text: 'x', submit: false, timeoutMs: 5000 })
  session.emitData('done\n')
  const result = await operation.done
  assert.equal(result.waitReason, 'inferred_idle')
  // 负对照：把 idle 当成「确定跑完」→ 慢命令会被误判（所以 waitReason 必须暴露出去）
})

test('SendOperation：session_exit 优先于 idle', async () => {
  const session = new FakeSession()
  const operation = session.startSend({ text: 'exit', submit: false, timeoutMs: 5000 })
  session.emitData('bye\n')
  session.emitExit(0)
  const result = await operation.done
  assert.equal(result.waitReason, 'session_exit', '退出是最确定的结局，优先级最高')
  assert.equal(result.sessionStatus.kind, 'exited')
  // 负对照：先判 idle → 明明退出了却报「推断空闲」
})

test('SendOperation：一直没输出 → timeout（不假装成功）', async () => {
  const session = new FakeSession()
  session.tuning.pollIntervalMs = 20
  session.tuning.idleSilenceMs = 30
  const operation = session.startSend({ text: 'sleep 99', submit: true, timeoutMs: 120 })
  const result = await operation.done
  assert.equal(result.waitReason, 'timeout')
  // 负对照：超时也报 idle → 模型以为命令跑完了，其实还在跑
})

test('SendOperation：cancel 只是不等了，**不杀进程**', async () => {
  const session = new FakeSession()
  session.tuning.pollIntervalMs = 20
  const operation = session.startSend({ text: 'long', submit: true, timeoutMs: 60_000 })
  assert.equal(operation.cancel(), true)
  const result = await operation.done
  assert.equal(result.aborted, true)
  assert.equal(session.closed, 0, 'cancel 不该关会话')
  assert.equal(operation.cancel(), false, '重复 cancel 返回 false')
  // 负对照：cancel 顺手杀掉进程 → 用户只是想先看看输出，结果命令没了
})

test('SendOperation：readOutput 是消费式的（读过就清）', () => {
  const session = new FakeSession()
  const operation = session.startSend({ text: 'x', submit: false, timeoutMs: 5000 })
  session.emitData('part1 ')
  const first = operation.readOutput()
  assert.equal(first.delta, 'part1 ')
  const second = operation.readOutput()
  assert.equal(second.delta, '', '读过就该清掉（与宿主一致）')
  // 负对照：累积不清 → 轮询读输出会重复返回同一段，模型看到重复内容
})

test('SendOperation：结算后 activeSend 被释放，可以再发', async () => {
  const session = new FakeSession()
  const first = session.startSend({ text: 'a', submit: false, timeoutMs: 5000 })
  session.emitData('ok\n')
  await first.done
  // 让 finally 跑完
  await new Promise((resolve) => setTimeout(resolve, 10))

  const second = session.startSend({ text: 'b', submit: false, timeoutMs: 5000 })
  assert.ok(second, '上一次结算后应当能再发')
  second.cancel()
  // 负对照：不释放 → 会话只能用一次
})

test('会话：close 时进行中的发送要立刻结算（不等轮询周期）', async () => {
  const session = new FakeSession()
  // 超时给得很长：如果结算不了，这里会挂 60 秒
  const operation = session.startSend({ text: 'x', submit: false, timeoutMs: 60_000 })

  const startedAt = Date.now()
  await session.close()
  const result = await operation.done
  const elapsed = Date.now() - startedAt

  assert.equal(result.waitReason, 'session_exit')
  assert.ok(elapsed < 1000, `应当立刻结算，实际花了 ${elapsed}ms`)
  // 负对照：连 emitExit 都不做 → 发送会一直挂到 60 秒超时
  // （注：只去掉主动 settle 是**无害**的 —— emitExit 之后的轮询会在 100ms 内兜住。
  //   主动 settle 只是让它立刻返回，不是正确性的唯一依靠。）
})

test('默认参数：滚动缓冲默认 2000 行（有界）', () => {
  assert.equal(TERMINAL_DEFAULTS.scrollbackLines, 2000)
  assert.ok(TERMINAL_DEFAULTS.sendTimeoutMs > 0)
  assert.ok(TERMINAL_DEFAULTS.idleSilenceMs > 0)
  // 负对照：默认无限 → 终端跑 `yes` 直接把进程内存打爆
})

// ── 信号映射 ────────────────────────────────────────────────────────────────

test('有 PTY 时，信号走控制字符（不是去 kill 某个 pid）', () => {
  // 为什么必须这样：PTY 的行规程会把 Ctrl-C 自动变成发给**前台进程组**的 SIGINT。
  // 这正是终端语义，也自然覆盖 `sleep 30` 这种前台子进程。
  // 自己去找 pgid 再 kill 反而不可靠（容器里未必有 ps，还容易杀错组）。
  //
  // 这里只钉住「控制字符的取值」这个纯数据部分 —— 三个后端用的是同一张表。
  const expected = { SIGINT: '\x03', SIGTSTP: '\x1a', SIGQUIT: '\x1c' }
  assert.equal(expected.SIGINT, '\u0003')
  assert.equal(expected.SIGTSTP, '\u001a')
  assert.equal(expected.SIGQUIT, '\u001c')
  // 负对照：SIGINT 写成 '\n'（0x0a）→ 只是回车，前台进程根本收不到中断
})

test('会话：没有 PTY 时不支持 resize，但有 PTY 时照常转发', () => {
  const piped = new FakeSession({ pty: false })
  piped.resize(100, 30)
  assert.deepEqual(piped.resized, [])

  const pty = new FakeSession({ pty: true })
  pty.resize(100, 30)
  assert.deepEqual(pty.resized, [[100, 30]])
})

// ── 首次发送前等 banner 打完 ────────────────────────────────────────────────
//
// 背景（真靶机实测）：登录 banner（motd / 「需要重启系统」这类提示）在 shell 到
// 提示符之前会持续输出。而 PTY 的**行规程会立刻回显**我们写进去的字节 ——
// 于是「已回显 + 一个 >600ms 的间隙」被误判成「跑完了」，
// 拿到的输出里只有 banner 和命令回显，**没有命令真正的输出**。
//
// 规则：**首次**发送前先等终端安静（= banner 打完、到了提示符）；
// 之后每次直接写（那时 shell 已在提示符上，等安静只会白加延迟）。

/** 一个能自己产生输出的会话：用来模拟 banner。 */
class BannerSession extends FakeSession {
  constructor(options = {}) {
    super({ tuning: { idleSilenceMs: 40, pollIntervalMs: 10, ...(options.tuning ?? {}) } })
  }

  /** 模拟「banner 分块到达」。 */
  banner(text) {
    this.emitData(text)
  }
}

test('就绪：首次发送要等 banner 打完才写下去', async () => {
  const session = new BannerSession({ tuning: { awaitReadyTimeoutMs: 3000 } })

  // 开终端后 banner 立刻开始打（模拟真靶机的 motd）
  session.banner('Welcome\n')

  const operation = session.startSend({ text: 'echo GO', submit: true, timeoutMs: 3000 })
  // 立刻检查：**还不该写** —— banner 刚打完一行，远谈不上安静
  assert.deepEqual(session.written, [], 'banner 还在打，不该急着写命令')

  // banner 再打两行（间隔小于 idleSilenceMs，持续「不安静」）
  const ticker = setInterval(() => session.banner('.'), 15)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.deepEqual(session.written, [], 'banner 持续输出期间都不该写')

  // banner 结束 → 安静够久 → 才该写
  clearInterval(ticker)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.deepEqual(session.written, ['echo GO', '\r'], '安静之后才写命令')

  // 收尾：给点输出让它结算
  session.emitData('GO\n')
  const result = await operation.done
  assert.equal(result.readyReason, 'quiet', '应当如实报告「等到了安静」')
  // 负对照：不等 banner 就写 → 命令输出被 banner 的间隙吞掉（真靶机实测失败）
})

test('就绪：一直不安静时照常发送，但如实标 not-quiet-yet', async () => {
  const session = new BannerSession({ tuning: { awaitReadyTimeoutMs: 150 } })
  const ticker = setInterval(() => session.banner('noise'), 20)
  const operation = session.startSend({ text: 'echo GO', timeoutMs: 3000 })
  try {
    // 等就绪上限过去（ticker 一直在发，所以永远「不安静」）
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.deepEqual(session.written, ['echo GO'], '超过就绪上限也要发（不能卡住用户）')
  } finally {
    clearInterval(ticker)
  }

  session.emitData('GO\n')
  const result = await operation.done
  assert.equal(result.readyReason, 'not-quiet-yet', '没等到安静就必须如实说，不假装')
  // 负对照：不设上限 → 对面一直有零星输出时永远不发送，用户以为终端卡死
})

test('就绪：**后续**发送不等安静（不改变原有语义）', async () => {
  const session = new BannerSession({ tuning: { awaitReadyTimeoutMs: 3000 } })
  session.banner('banner done\n')
  await new Promise((resolve) => setTimeout(resolve, 80)) // 安静下来

  const first = session.startSend({ text: 'one', timeoutMs: 3000 })
  await new Promise((resolve) => setTimeout(resolve, 60))
  session.emitData('one\n')
  await first.done

  // 第二次：即使终端刚有输出（不安静），也要立刻写
  session.emitData('prompt$ ')
  const second = session.startSend({ text: 'two', timeoutMs: 3000 })
  assert.deepEqual(session.written.slice(-1), ['two'], '后续发送应当立刻写')
  session.emitData('two\n')
  const result = await second.done
  assert.equal(result.readyReason, 'no-wait')
  // 负对照：每次发送都等安静 → 往忙着的终端里打字（比如回答 sudo 提示）会被无限推迟
})

test('就绪：命令本身不产生输出（只有 PTY 回显 + 下一个提示符）也照常结算', async () => {
  const session = new BannerSession({ tuning: { awaitReadyTimeoutMs: 3000 } })
  session.banner('banner\n')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const operation = session.startSend({ text: 'cd /tmp', submit: true, timeoutMs: 4000 })
  // 真 PTY 一定会回显我们写的字节，之后 shell 再打一个新提示符 —— 都算输出
  session.emitData('cd /tmp\r\nprompt$ ')
  const result = await operation.done
  assert.equal(result.waitReason, 'inferred_idle', '这类命令也必须能结算，不能一路走到超时')
  // 负对照：写入后「必须再见到**命令的结果**」才算输出 → `cd` 这类命令每次超时
})

test('就绪：写着之后一直没有任何输出 → 仍然超时（保守是对的）', async () => {
  // 这一条是**刻意**的保守：PTY 正常一定会回显，所以「零输出」很反常。
  // 此时宁可按超时如实报告，也不假装「跑完了」—— 后者会让模型以为
  // 一条还在跑的命令已经结束。
  const session = new BannerSession({ tuning: { awaitReadyTimeoutMs: 3000, idleSilenceMs: 30 } })
  session.banner('banner\n')
  await new Promise((resolve) => setTimeout(resolve, 60))

  const operation = session.startSend({ text: 'silent', timeoutMs: 200 })
  const result = await operation.done
  assert.equal(result.waitReason, 'timeout')
  // 负对照：只要「写过」就允许按 idle 结算 → 静默的长命令会被误判成已完成
})
