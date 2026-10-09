/**
 * `src/world/search.js` 的契约测试 —— 远程版 `glob` / `grep`。
 *
 * ## 为什么要有这个模块
 *
 * 宿主自带的 `glob` / `grep` 用**打包在宿主里的 ripgrep** + `subprocess` 接缝，
 * 跑在**本机**、搜的是**本地镜像** —— 大文件与深层目录根本搜不到。
 * 这与「工作区在远程」矛盾，所以自己实现一份，在隔离域内用远程的 `find` / `grep`。
 *
 * 测试分两层：
 *   1. **纯逻辑**（命令生成 + 输出解析）—— 不连网，人人可跑
 *   2. **真机端到端**（真在 Linux 上跑生成的命令）—— 只在设了环境变量时才跑
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  globToEre,
  buildGlobCommand,
  buildGrepCommand,
  parseGlobOutput,
  parseGrepOutput,
  renderGlobText,
  renderGrepText,
  PRUNED_DIRS,
  DEFAULT_MAX_RESULTS,
} from '../src/world/search.js'
import { WslTransport } from '../src/transport/wsl.js'
import { registerTransport, clearTransports } from '../src/transport/registry.js'
import { registerWorkspaceRoute, clearWorkspaceRoutes } from '../src/session/workspace-routes.js'

// ── 1. 纯逻辑 ────────────────────────────────────────────────────────────────

test('globToEre：没有 "/" 的模式按**任意深度的文件名**匹配', () => {
  const { source, basenameOnly } = globToEre('*.ts')
  assert.equal(basenameOnly, true)
  const re = new RegExp(source)
  assert.ok(re.test('a.ts'), '根目录下的要匹配')
  assert.ok(re.test('src/deep/b.ts'), '深层目录下的也要匹配')
  assert.ok(!re.test('a.js'), '后缀不对的不该匹配')
  assert.ok(!re.test('a.tsx'), '`*` 不能跨越扩展名边界')
  // 负对照：把 `*.ts` 当成「只匹配根目录」→ 全树搜索变成只看根，模型会以为文件不存在
})

test('globToEre：含 "/" 的模式从搜索根匹配整条相对路径', () => {
  const re = new RegExp(globToEre('src/*.js').source)
  assert.ok(re.test('src/a.js'))
  assert.ok(!re.test('src/deep/a.js'), '`*` 不跨层')
  assert.ok(!re.test('other/src/a.js'), '必须从根开始匹配')

  const deep = new RegExp(globToEre('src/**/*.js').source)
  assert.ok(deep.test('src/a.js'), '`**/` 要能匹配「零层」')
  assert.ok(deep.test('src/deep/nested/a.js'))
  // 负对照：把 `**` 当普通 `*` → 深层文件全丢
})

test('globToEre：`?` 与字面量点号被正确处理', () => {
  const re = new RegExp(globToEre('a?.txt').source)
  assert.ok(re.test('ab.txt'))
  assert.ok(!re.test('abc.txt'), '`?` 恰好一个字符')
  assert.ok(!re.test('abXtxt'), '点号必须是字面量，不能变成「任意字符」')
  // 负对照：不转义 `.` → `a?.txt` 会匹配 `abXtxt`，搜出一堆无关文件
})

test('globToEre：空 pattern 要抛错，不静默返回「全部」', () => {
  assert.throws(() => globToEre(''), /不能为空/)
  assert.throws(() => globToEre('   '), /不能为空/)
  // 负对照：空模式当成 `*` → 一次搜索把整个仓库列出来
})

test('buildGlobCommand：剪枝 + 不用 -printf + 有上限', () => {
  const cmd = buildGlobCommand({ root: '/srv/proj', ere: '^.*\\.ts$', cap: 50 })
  assert.match(cmd, /cd '\/srv\/proj'/, '要 cd 到远程根')
  for (const dir of PRUNED_DIRS) assert.ok(cmd.includes(dir), `应当剪枝 ${dir}`)
  // ⚠️ 关键：busybox 的 find **没有 -printf**（实测在 alpine 上挂过）
  assert.ok(!cmd.includes('-printf'), '不能用 -printf —— busybox 的 find 没有它')
  assert.match(cmd, /stat -c/, '要用 stat 取修改时间（GNU 与 busybox 都支持 -c）')
  assert.match(cmd, /head -n 51/, '取 cap + 1 条，好判断有没有被截断')
  assert.match(cmd, /sort -rn/, '按修改时间倒序（与宿主那份的契约一致）')
  // 负对照：用 -printf → alpine/docker 上整个搜索报错
})

test('buildGrepCommand：用 grep -nHI、支持 include、支持大括号', () => {
  const cmd = buildGrepCommand({ root: '/srv/proj', pattern: 'TODO', cap: 10 })
  assert.match(cmd, /grep -nHI -E/, '要行号 + 文件名 + 跳过二进制')

  // ⚠️ **不能接 `| head`**：管道里 head 的退出码会盖掉 grep 的 ——
  // 正则写错时 grep 退出 2，而整条管道仍「成功」，工具于是报「没有匹配」。
  // 那是静默失败（真机测试抓到过）。上限交给 stdoutMaxBytes 与 Node 侧的 cap。
  assert.ok(!/\|\s*head\b/.test(cmd), 'grep 命令不能接 head（会掩掉 grep 的退出码）')
  // `cd … 2>/dev/null` 是刻意的（用退出码判断根目录不存在）；
  // 但**真正跑 grep 的那一行不能吞 stderr** —— 出错时要把原因报出来
  const grepLine = cmd.split('\n').find((line) => line.includes('grep -nHI')) ?? ''
  assert.ok(grepLine !== '', '应当能定位到 grep 那一行')
  assert.ok(!grepLine.includes('2>/dev/null'), 'grep 那一行不能吞 stderr')

  const withInclude = buildGrepCommand({ root: '/r', pattern: 'x', include: '*.ts', cap: 10 })
  assert.match(withInclude, /-name '\*\.ts'/, 'include 要变成 find -name')

  // 大括号要**展开**成多个 -name（find 不认识 `{js,jsx}`）
  const braces = buildGrepCommand({ root: '/r', pattern: 'x', include: '*.{js,jsx}', cap: 10 })
  assert.match(braces, /-name '\*\.js' -o -name '\*\.jsx'/, '大括号要展开成多个 -name')
  assert.ok(!braces.includes('{js,jsx}'), '不能把大括号原样塞给 find')
  // 负对照：直接把 `*.{js,jsx}` 给 find -name → 一个文件都匹配不到，
  //          而工具会报「没有匹配」——用户以为真的没有，是误导
})

test('buildGrepCommand：pattern 里的引号不会破坏命令结构', () => {
  const cmd = buildGrepCommand({ root: '/r', pattern: "it's", cap: 10 })
  assert.ok(cmd.includes(`'it'\\''s'`), '单引号要被正确转义')
  // 负对照：直接拼进命令 → 命令结构被破坏（甚至能注入任意命令）
})

test('parseGlobOutput：解析「修改时间 + 路径」，路径里可以有空格', () => {
  const stdout = ['1700000000 ./b.ts', '1700000001 ./src/a.ts', '1700000002 ./带 空格 的名字.ts'].join('\n')
  const { paths, truncated } = parseGlobOutput(stdout, 10)
  assert.deepEqual(paths, ['b.ts', 'src/a.ts', '带 空格 的名字.ts'])
  assert.equal(truncated, false)
  // 负对照：按空格 split 成两段 → 带空格的文件名被截断
})

test('parseGlobOutput：超过上限要标 truncated（不静默丢结果）', () => {
  const stdout = Array.from({ length: 5 }, (_, i) => `170000000${i} ./f${i}.ts`).join('\n')
  const { paths, truncated } = parseGlobOutput(stdout, 3)
  assert.equal(paths.length, 3)
  assert.equal(truncated, true)
  // 负对照：截断了却说没截断 → 模型以为「只有 3 个文件」
})

test('parseGrepOutput：解析 ./path:line:text，路径含冒号也能处理', () => {
  const stdout = [
    './src/a.ts:12:const x = 1',
    './weird:name.js:3:hello',
    'not-a-match-line',
  ].join('\n')
  const { matches, truncated } = parseGrepOutput(stdout, 10)
  assert.deepEqual(matches, [
    { path: 'src/a.ts', lineNumber: 12, line: 'const x = 1' },
    { path: 'weird:name.js', lineNumber: 3, line: 'hello' },
  ])
  assert.equal(truncated, false)
  // 负对照：按第一个冒号切 → `weird:name.js` 那条被解析成路径 `weird`、行号 NaN
})

test('parseGrepOutput：行内容里还有冒号也不受影响', () => {
  const { matches } = parseGrepOutput('./a.ts:5:key: value: 1', 10)
  assert.deepEqual(matches, [{ path: 'a.ts', lineNumber: 5, line: 'key: value: 1' }])
  // 负对照：拿去尾冒号反推 → 行内容被吃掉
})

test('渲染：空结果、截断提示都要说清楚', () => {
  assert.match(renderGlobText([], '/r', false), /没有匹配的文件/)
  const truncatedGlob = renderGlobText(['a.ts'], '/r', true)
  assert.match(truncatedGlob, /被截断/)

  assert.match(renderGrepText([], '/r', false), /没有匹配/)
  const grouped = renderGrepText(
    [
      { path: 'a.ts', lineNumber: 1, line: 'x' },
      { path: 'a.ts', lineNumber: 9, line: 'y' },
      { path: 'b.ts', lineNumber: 2, line: 'z' },
    ],
    '/r',
    false,
  )
  assert.match(grouped, /a\.ts:\n {2}1: x\n {2}9: y/, '应当按文件分组')
  // 负对照：截断了不提示 → 模型以为搜到的就是全部
})

test('默认上限是有界的', () => {
  assert.ok(Number.isFinite(DEFAULT_MAX_RESULTS) && DEFAULT_MAX_RESULTS > 0 && DEFAULT_MAX_RESULTS <= 1000)
  // 负对照：默认无限 → 一次 `grep .` 把上下文撑爆
})

// ── 2. 真机端到端（在真的 Linux 上跑生成的命令）─────────────────────────────

const enabled = process.env.DSH_MR_WSL_TEST === '1'
const DISTRO = process.env.DSH_MR_WSL_DISTRO ?? 'Ubuntu-24.04'
/** 沙箱放 `/var/tmp`：WSL 的 `/tmp` 每次发行版启动都会被清空（实测踩到）。 */
const SANDBOX = process.env.DSH_MR_WSL_SANDBOX ?? '/var/tmp/dsh-mr-search-e2e'
const skip = enabled ? false : '未设置 DSH_MR_WSL_TEST=1（需要 Windows + WSL2）'

test('真机：生成的 glob 命令真的能在 Linux 上跑出结果', { skip }, async () => {
  const transport = new WslTransport({ distro: DISTRO })
  await transport.connect()
  try {
    const setup = await transport.exec(
      `rm -rf ${SANDBOX} && mkdir -p ${SANDBOX}/src/deep ${SANDBOX}/node_modules && ` +
      `echo a > ${SANDBOX}/a.ts && echo b > ${SANDBOX}/src/b.ts && ` +
      `echo c > ${SANDBOX}/src/deep/c.ts && echo d > ${SANDBOX}/d.js && ` +
      `echo e > ${SANDBOX}/node_modules/ignored.ts && echo "TODO here" > ${SANDBOX}/src/todo.txt`,
    )
    assert.equal(setup.code, 0, `准备沙箱失败：${setup.stderr}`)

    // 无 "/" 的 pattern：任意深度
    const { source } = globToEre('*.ts')
    const globRun = await transport.exec(buildGlobCommand({ root: SANDBOX, ere: source, cap: 50 }))
    assert.equal(globRun.code, 0, `glob 命令失败：${globRun.stderr}`)
    const { paths } = parseGlobOutput(globRun.stdout, 50)

    assert.ok(paths.includes('a.ts'), `应当找到 a.ts，实际：${paths.join(', ')}`)
    assert.ok(paths.includes('src/deep/c.ts'), `应当递归找到深层文件，实际：${paths.join(', ')}`)
    assert.ok(!paths.some((p) => p.includes('node_modules')), 'node_modules 应当被剪枝')
    assert.ok(!paths.some((p) => p.endsWith('.js')), '`*.ts` 不该匹配 .js')

    // grep
    const grepRun = await transport.exec(buildGrepCommand({ root: SANDBOX, pattern: 'TODO', include: undefined, cap: 50 }))
    assert.equal(grepRun.code, 0, `grep 命令失败：${grepRun.stderr}`)
    const { matches } = parseGrepOutput(grepRun.stdout, 50)
    assert.equal(matches.length, 1, `应当恰好一条匹配，实际：${JSON.stringify(matches)}`)
    assert.equal(matches[0].path, 'src/todo.txt')
    assert.equal(matches[0].lineNumber, 1)
    assert.match(matches[0].line, /TODO here/)
  } finally {
    await transport.exec(`rm -rf ${SANDBOX}`).catch(() => {})
    await transport.disconnect()
  }
  // 负对照：命令用 -printf → busybox 上直接失败（alpine 实测过）
})

test('真机：grep 的 include 过滤生效；没有匹配时退出码 1 不算失败', { skip }, async () => {
  const transport = new WslTransport({ distro: DISTRO })
  await transport.connect()
  try {
    await transport.exec(`rm -rf ${SANDBOX} && mkdir -p ${SANDBOX} && echo TARGET > ${SANDBOX}/a.ts && echo TARGET > ${SANDBOX}/b.js`)

    const only = await transport.exec(buildGrepCommand({ root: SANDBOX, pattern: 'TARGET', include: '*.ts', cap: 50 }))
    assert.equal(only.code, 0)
    const { matches } = parseGrepOutput(only.stdout, 50)
    assert.deepEqual(matches.map((m) => m.path), ['a.ts'], 'include=*.ts 应当只搜 .ts')

    const none = await transport.exec(buildGrepCommand({ root: SANDBOX, pattern: '绝对不存在的字符串xyzzy', include: undefined, cap: 50 }))
    assert.equal(none.code, 1, 'grep 没有匹配时退出码是 1 —— 那是正常结果')
    assert.deepEqual(parseGrepOutput(none.stdout, 50).matches, [])
  } finally {
    await transport.exec(`rm -rf ${SANDBOX}`).catch(() => {})
    await transport.disconnect()
  }
  // 负对照：把退出码 1 当失败 → 正常的「没搜到」会报成错误
})

// ── 超时：返回部分结果，而不是一句报错 ──────────────────────────────────────

test('搜索超时：返回已找到的部分结果，并如实标注不完整', async () => {
  // 实测背景（2026-10-07）：用户连的是整个家目录，30 秒搜不完 ——
  // 旧行为是**直接抛「搜索超时」**，一条结果都拿不到。
  // 但 find/grep 是边跑边输出的：已找到的部分完全有用。
  const registered = []
  const fakeShell = {
    resolve: (request) => request,
    execute: async () => ({
      result: async () => ({
        exitCode: null, signal: null, timedOut: true, aborted: false, timeoutMs: 30_000,
        stdout: { text: '1700000000 ./a.ts\n1700000001 ./src/b.ts\n', truncated: false },
        stderr: { text: '', truncated: false },
      }),
    }),
  }
  const ctx = {
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    effect: (fn) => { fn(); return () => {} },
    shell: fakeShell,
  }
  apply(ctx, {})
  // 方案 A：search 按路径路由，测试要注册一个工作区路由（transport 只需存在，search 走 fakeShell）
  registerTransport('search-test', { kind: 'ssh' })
  registerWorkspaceRoute('search-test', { remoteRoot: '/r', anchorPath: 'D:/a/mr-x' })

  try {
    const globTool = registered.find((definition) => definition.name === 'glob')
    assert.ok(globTool !== undefined, '应当注册 glob')

    const out = await globTool.execute({ pattern: '*.ts', path: '/r' }, {})
    assert.equal(out.partial, true, '超时要标 partial')
    assert.deepEqual(out.paths, ['a.ts', 'src/b.ts'], '已找到的部分要带回来，不能丢')

    const text = globTool.output.render({}, out)[0].text
    assert.match(text, /可能不完整/, '必须如实告诉模型结果不完整')
  } finally {
    clearTransports()
    clearWorkspaceRoutes()
  }
  // 负对照：超时直接抛错 → 用户什么结果都没有，只看到一句「搜索超时」
})

test('搜索超时且一条都没找到：要说明「没搜到 ≠ 不存在」', async () => {
  const registered = []
  const ctx = {
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    effect: (fn) => { fn(); return () => {} },
    shell: {
      resolve: (request) => request,
      execute: async () => ({
        result: async () => ({
          exitCode: null, signal: null, timedOut: true, aborted: false, timeoutMs: 30_000,
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
        }),
      }),
    },
  }
  apply(ctx, {})
  registerTransport('search-test', { kind: 'ssh' })
  registerWorkspaceRoute('search-test', { remoteRoot: '/r', anchorPath: 'D:/a/mr-x' })

  try {
    const grepTool = registered.find((definition) => definition.name === 'grep')
    const out = await grepTool.execute({ pattern: 'x', path: '/r' }, {})
    const text = grepTool.output.render({}, out)[0].text
    assert.match(text, /不等于「不存在」/, '超时的「没搜到」必须说清楚，不能让人以为真的没有')
  } finally {
    clearTransports()
    clearWorkspaceRoutes()
  }
  // 负对照：只说「没有匹配」 → 模型据此断言「文件里没有这个字符串」，是错的
})