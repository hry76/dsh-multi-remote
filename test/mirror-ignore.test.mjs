/**
 * `src/mirror/ignore.js` 的契约测试。
 *
 * 每条关键行为都配一个**负对照**：一个「如果实现退化就必然失败」的断言。
 * 负对照的意义在于证明这条测试不是摆设 —— 见每个 test 里的 `负对照：` 注释。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { IgnoreRules, BUILTIN_IGNORES } from '../src/mirror/ignore.js'

/** 断言辅助：`ignores()` 的简写。 */
const hit = (rules, path, isDirectory = false) => rules.ignores(path, { isDirectory })

test('注释与空行不产生规则', () => {
  const rules = IgnoreRules.parse('# 这是注释\n\n   \n!nope\n')
  assert.equal(rules.size, 1)
  assert.equal(hit(rules, 'nope'), false)
  // 负对照：把 `#` 判断去掉，注释行会被当成模式 `# 这是注释`，size 立刻变 3
})

test('转义的 # 与 ! 是字面量模式', () => {
  const rules = IgnoreRules.parse('\\#literal\n\\!bang\n')
  assert.equal(rules.size, 2)
  assert.equal(hit(rules, '#literal'), true)
  assert.equal(hit(rules, '!bang'), true)
  // 负对照：去掉 `\\#` / `\\!` 分支，两条规则都会被当成注释或取反 → size 为 0/1
})

test('裸模式匹配任意层级，锚定模式只匹配仓库根', () => {
  const bare = IgnoreRules.parse('*.log')
  assert.equal(hit(bare, 'app.log'), true)
  assert.equal(hit(bare, 'deep/nested/app.log'), true)

  const anchored = IgnoreRules.parse('/build')
  assert.equal(hit(anchored, 'build', true), true)
  assert.equal(hit(anchored, 'packages/build', true), false)
  // 负对照：把 anchored 一律当 false，第二条断言会失败（`packages/build` 被误忽略）
})

test('含中间斜杠的模式也是锚定的', () => {
  const rules = IgnoreRules.parse('src/gen/*.js')
  assert.equal(hit(rules, 'src/gen/a.js'), true)
  assert.equal(hit(rules, 'deep/src/gen/a.js'), false)
  // 负对照：去掉「中间斜杠 → 锚定」的判断，第二条会失败
})

test('目录限定规则不匹配同名文件', () => {
  const rules = IgnoreRules.parse('build/')
  assert.equal(hit(rules, 'build', true), true)
  assert.equal(hit(rules, 'build', false), false)
  // 负对照：把 directoryOnly 判断去掉，`build` 这个普通文件会被误忽略
})

test('取反规则按「最后命中者说话」', () => {
  const rules = IgnoreRules.parse('*.log\n!keep.log\n')
  assert.equal(hit(rules, 'a.log'), true)
  assert.equal(hit(rules, 'keep.log'), false)
  assert.equal(hit(rules, 'sub/keep.log'), false)
  // 负对照：忽略 negated 标志，`keep.log` 会返回 true

  const reversed = IgnoreRules.parse('!keep.log\n*.log\n')
  assert.equal(hit(reversed, 'keep.log'), true)
  // 负对照：若把规则倒序求值，这条会返回 false
})

test('`*` 不跨目录，`**` 跨目录', () => {
  const single = IgnoreRules.parse('a/*.js')
  assert.equal(hit(single, 'a/x.js'), true)
  assert.equal(hit(single, 'a/b/x.js'), false)

  const double = IgnoreRules.parse('a/**/x.js')
  assert.equal(hit(double, 'a/x.js'), true)
  assert.equal(hit(double, 'a/b/x.js'), true)
  assert.equal(hit(double, 'a/b/c/x.js'), true)
  // 负对照：把 `**` 编译成 `[^/]*`，`a/b/x.js` 与 `a/b/c/x.js` 都会失败
})

test('`?` 与字符类可用', () => {
  const rules = IgnoreRules.parse('?.tmp\n[abc].out\n')
  assert.equal(hit(rules, 'x.tmp'), true)
  assert.equal(hit(rules, 'xy.tmp'), false)
  assert.equal(hit(rules, 'a.out'), true)
  assert.equal(hit(rules, 'd.out'), false)
  // 负对照：把 `?` 当字面量，`x.tmp` 会失败
})

test('未闭合的字符类退化成字面量而不是非法正则', () => {
  const rules = IgnoreRules.parse('[unclosed\n')
  assert.equal(rules.size, 1)
  assert.equal(hit(rules, '[unclosed'), true)
  // 负对照：直接 new RegExp('[unclosed') 会抛异常 → 整个 parse 崩掉
})

test('被忽略的目录由调用方剪枝 —— 取反规则不会把它救回来', () => {
  // 这是 git 的真实语义：目录一旦被忽略就不再下潜。
  // 镜像层必须照做，否则一个 `!important.txt` 就能把 node_modules 整个拉回来。
  const rules = IgnoreRules.parse('node_modules/\n!node_modules/important.txt\n')
  assert.equal(hit(rules, 'node_modules', true), true, '目录本身被忽略 → 调用方必须剪枝')
  // 负对照：若实现改成「先看子路径再决定」，就会有人去下潜 node_modules 找 important.txt
})

test('内置兜底规则覆盖常见重目录', () => {
  for (const dir of ['node_modules', '.git', 'dist', 'build', 'target', '__pycache__', '.venv']) {
    assert.equal(hit(BUILTIN_IGNORES, dir, true), true, `${dir} 应被内置规则忽略`)
  }
  assert.equal(hit(BUILTIN_IGNORES, 'src', true), false)
  assert.equal(hit(BUILTIN_IGNORES, 'src/index.js'), false)
  // 负对照：BUILTIN_IGNORES 置空 → 第一条循环失败
})

test('内置规则与项目规则可合并，项目规则在后', () => {
  const merged = IgnoreRules.merge(BUILTIN_IGNORES, IgnoreRules.parse('vendor/\n!build/\n'))
  assert.equal(hit(merged, 'vendor', true), true, '项目规则生效')
  assert.equal(hit(merged, 'build', true), false, '项目规则可以取反掉内置规则')
  assert.equal(hit(merged, 'node_modules', true), true, '内置规则仍在')
  // 负对照：merge 顺序反过来，`build` 会被内置规则忽略 → 第二条失败
})

test('路径归一化：反斜杠、前导 ./ 与重复斜杠', () => {
  const rules = IgnoreRules.parse('a/b.txt')
  assert.equal(hit(rules, 'a\\b.txt'), true)
  assert.equal(hit(rules, './a/b.txt'), true)
  assert.equal(hit(rules, 'a//b.txt'), true)
  // 负对照：去掉 normalizeRelPath，三条全失败（Windows 路径尤其致命）
})

test('空路径永不忽略，空规则集什么都不忽略', () => {
  assert.equal(IgnoreRules.empty().ignores(''), false)
  assert.equal(IgnoreRules.empty().ignores('anything/at/all.js'), false)
  assert.equal(hit(IgnoreRules.parse('*'), ''), false)
  // 负对照：空路径若进入匹配，`*` 规则会把根目录本身也忽略掉
})
