/**
 * 「连接前校验远程项目根」的契约测试。
 *
 * ## 为什么有这个模块
 *
 * 2026-10-07 真机事故：用户把远程根填成 `~/新建文件夹`，
 * 而远程**没有这个目录**（真实位置是 `~/桌面/新建文件夹`）。
 * 结果：**连接成功**，但之后每条命令都先 `cd` 到不存在的目录 → 失败，
 * 报错只有一句含糊的 `cd: No such file or directory`。
 * 用户和模型都花了很久才反应过来是路径填错了，中间还怀疑插件坏了。
 *
 * 结论：路径是用户在界面上填的，我们就该**当场**验证，
 * 并把「同名目录在哪」直接告诉他。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildRootCheckCommand, parseRootCheck, verifyRemoteRoot, ROOT_CHECK_MARKER } from '../src/session/verify-root.js'

/** 造一个只会回固定 stdout 的假传输层。 */
function fakeTransport(stdout) {
  return {
    async exec() {
      return { code: 0, stdout, stderr: '' }
    },
  }
}

test('buildRootCheckCommand：带标记、路径被安全引用', () => {
  const command = buildRootCheckCommand('/home/user/新建文件夹')
  assert.ok(command.includes(ROOT_CHECK_MARKER), '要带标记 —— 测试替身靠它识别这条命令')

  // 路径里的空格、单引号、中文都不能破坏命令结构
  const tricky = buildRootCheckCommand("/tmp/it's a dir")
  assert.ok(tricky.includes(`'/tmp/it'\\''s a dir'`), '单引号要被正确转义')
  // 负对照：直接拼路径 → 路径里一个引号就能注入任意命令
})

test('parseRootCheck：三种状态 + 父目录 + 同名目录建议', () => {
  assert.equal(parseRootCheck('OK\n').status, 'ok')
  assert.equal(parseRootCheck('NOTDIR\n').status, 'notdir')
  assert.equal(parseRootCheck('MISSING\n').status, 'missing')

  assert.equal(parseRootCheck('OK\nPARENT_OK\n').parentExists, true)
  assert.equal(parseRootCheck('MISSING\nPARENT_MISSING\n').parentExists, false)

  // **用户那次真实输出**：路径不存在，但在父目录下找到了同名目录
  const real = parseRootCheck('MISSING\nPARENT_OK\n/home/user/桌面/新建文件夹\n')
  assert.equal(real.status, 'missing')
  assert.deepEqual(real.candidates, ['/home/user/桌面/新建文件夹'])
  // 负对照：把建议行也当状态解析 → 状态判断错乱
})

test('verifyRemoteRoot：目录存在就直接放行', async () => {
  const result = await verifyRemoteRoot(fakeTransport('OK\nPARENT_OK\n'), '/home/user/proj')
  assert.equal(result.status, 'ok')
})

test('verifyRemoteRoot：目录不存在 → 报错要说清三件事', async () => {
  const transport = fakeTransport('MISSING\nPARENT_OK\n/home/user/桌面/新建文件夹\n')
  await assert.rejects(
    () => verifyRemoteRoot(transport, '/home/user/新建文件夹'),
    (error) => {
      assert.equal(error.code, 'REMOTE_ROOT_MISSING', '要有稳定的错误码')
      // ① 哪条路径有问题
      assert.match(error.message, /\/home\/user\/新建文件夹/, '要回显用户填的路径')
      // ② 为什么连上也用不了
      assert.match(error.message, /每条命令都会先切到这个目录/, '要解释后果')
      // ③ **照着他能做的下一步**：同名目录在哪
      assert.match(error.message, /\/home\/user\/桌面\/新建文件夹/, '要给出找到的同名目录')
      assert.match(error.message, /mkdir -p/, '要给「如果这是新目录」的做法')
      assert.deepEqual(error.candidates, ['/home/user/桌面/新建文件夹'])
      return true
    },
  )
  // 负对照：只报一句「远程目录不存在」→ 用户还是不知道该填什么
})

test('verifyRemoteRoot：父目录也不存在时说清楚「整条路径可能都错了」', async () => {
  await assert.rejects(
    () => verifyRemoteRoot(fakeTransport('MISSING\nPARENT_MISSING\n'), '/typo/entire/path'),
    (error) => {
      assert.match(error.message, /整条路径可能都写错了/)
      assert.doesNotMatch(error.message, /找到同名目录/, '没有建议时不要编一个')
      return true
    },
  )
})

test('verifyRemoteRoot：路径存在但不是目录，要区分开', async () => {
  await assert.rejects(
    () => verifyRemoteRoot(fakeTransport('NOTDIR\nPARENT_OK\n'), '/home/user/some-file.txt'),
    (error) => {
      assert.match(error.message, /不是一个目录/, '是文件还是缺目录，说法要不一样')
      assert.equal(error.code, 'REMOTE_ROOT_MISSING')
      return true
    },
  )
  // 负对照：统一报「不存在」→ 用户去建目录，结果发现那里有个同名文件
})
