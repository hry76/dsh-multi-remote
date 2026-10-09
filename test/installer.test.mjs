/**
 * `scripts/install.mjs` 的契约测试。
 *
 * 这个安装器解决的是**真实失败模式**（已实测复现）：
 * pnpm 11+ 拒绝未表态的构建脚本 → 非零退出码 → `dsh plugin` **不登记 bundle**
 * → 「装上了但从不加载，且没有任何提示」。
 *
 * 所以测试重点是：
 *   - 表态写入必须是**外科手术式**的（不弄丢用户已有的注释与配置）
 *   - 已存在的用户决定**不被覆盖**
 *   - bundle 校验能识别出「没登记」这种情况
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mergeAllowBuilds, readBundles, parseArgs, resolveDshHome, isPlaceholderDecision, BUILD_SCRIPT_DECISIONS, PACKAGE_NAME } from '../scripts/install.mjs'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'installer-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('isPlaceholderDecision：只有 true/false 才算「已做出有效决定」', () => {
  assert.equal(isPlaceholderDecision('true'), false)
  assert.equal(isPlaceholderDecision('false'), false)
  assert.equal(isPlaceholderDecision(' true '), false)

  // pnpm 生成的占位文案 —— 它自己都不认这种值
  assert.equal(isPlaceholderDecision('set this to true or false'), true)
  assert.equal(isPlaceholderDecision('set this to false'), true)
  assert.equal(isPlaceholderDecision(''), true)
  assert.equal(isPlaceholderDecision('maybe'), true)
  assert.equal(isPlaceholderDecision('1'), true)
  // 负对照：把占位符当成有效决定 → 下一次安装仍会 ERR_PNPM_IGNORED_BUILDS 失败
})

test('mergeAllowBuilds：pnpm 的占位符必须被改写（实测踩到过）', () => {
  // 这是实测场景：`dsh plugin add` 失败后，pnpm 在 profile 里留下
  //   allowBuilds:
  //     ssh2: set this to true or false
  // 留着它等于没表态 —— 下一次安装还是失败。
  const existing = [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    'allowBuilds:',
    '  cpu-features: set this to true or false',
    '  ssh2: set this to true or false',
    '',
  ].join('\n')

  const result = mergeAllowBuilds(existing, BUILD_SCRIPT_DECISIONS)

  assert.deepEqual(result.replaced.sort(), ['cpu-features', 'ssh2'])
  assert.deepEqual(result.added, [], '不该重复追加，应当就地改写')
  assert.deepEqual(result.kept, [])
  assert.ok(!result.text.includes('set this to'), '占位符必须被彻底清掉')
  assert.match(result.text, /^\s+ssh2: false$/m)
  assert.match(result.text, /^\s+cpu-features: false$/m)
  // 用户的其他配置与注释仍要保留
  assert.ok(result.text.includes('nodeLinker: hoisted'))
  assert.ok(result.text.includes('  - .'))
  // 负对照：把占位符当成「用户已有决定」而跳过 → 安装继续失败
})

test('mergeAllowBuilds：改写占位符后再跑一次是幂等的', () => {
  const existing = ['allowBuilds:', '  ssh2: set this to true or false', ''].join('\n')
  const first = mergeAllowBuilds(existing, BUILD_SCRIPT_DECISIONS)
  const second = mergeAllowBuilds(first.text, BUILD_SCRIPT_DECISIONS)

  assert.equal(second.text, first.text)
  assert.deepEqual(second.replaced, [], '第二次不该再有占位符可改')
  assert.deepEqual(second.kept.sort(), ['cpu-features', 'ssh2'])
  // 负对照：每次把值当占位符改写 → 内容反复变动，永远不幂等
})

test('mergeAllowBuilds：空文件时追加完整表态段', () => {
  const result = mergeAllowBuilds('', BUILD_SCRIPT_DECISIONS)
  assert.deepEqual(result.added.sort(), ['cpu-features', 'ssh2'])
  assert.match(result.text, /^allowBuilds:/m)
  assert.match(result.text, /^\s+ssh2: false$/m)
  assert.match(result.text, /^\s+cpu-features: false$/m)
  // 负对照：不写表态段，pnpm 仍会以 ERR_PNPM_IGNORED_BUILDS 失败
})

test('mergeAllowBuilds：保留用户已有的注释与其他配置（外科手术式）', () => {
  const existing = [
    '# 用户自己写的注释，不能丢',
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    '',
  ].join('\n')

  const result = mergeAllowBuilds(existing, BUILD_SCRIPT_DECISIONS)
  assert.ok(result.text.includes('# 用户自己写的注释，不能丢'), '注释必须保留')
  assert.ok(result.text.includes('nodeLinker: hoisted'), '其他配置必须保留')
  assert.ok(result.text.includes('autoInstallPeers: false'))
  assert.ok(result.text.includes('  - .'))
  assert.match(result.text, /^allowBuilds:$/m)
  // 负对照：用 YAML 解析再整体重写，注释与顺序都会丢
})

test('mergeAllowBuilds：已有 allowBuilds 段时合并进去，不重复建段', () => {
  const existing = ['allowBuilds:', '  some-other-pkg: true', ''].join('\n')
  const result = mergeAllowBuilds(existing, BUILD_SCRIPT_DECISIONS)

  const occurrences = result.text.match(/^allowBuilds:/gm) ?? []
  assert.equal(occurrences.length, 1, '不能出现两个 allowBuilds 段（YAML 会取后者，前一段静默失效）')
  assert.ok(result.text.includes('some-other-pkg: true'), '用户已有的条目要保留')
  assert.match(result.text, /^\s+ssh2: false$/m)
  // 负对照：无条件追加新段 → 两个 allowBuilds，用户原意被覆盖
})

test('mergeAllowBuilds：用户已表态过的键不被覆盖', () => {
  const existing = ['allowBuilds:', '  ssh2: true', ''].join('\n')
  const result = mergeAllowBuilds(existing, BUILD_SCRIPT_DECISIONS)

  assert.deepEqual(result.kept, ['ssh2'])
  assert.ok(!result.added.includes('ssh2'))
  assert.match(result.text, /^\s+ssh2: true$/m, '用户的选择必须保留')
  assert.match(result.text, /^\s+cpu-features: false$/m, '缺的那个要补上')
  // 负对照：无条件覆盖成 false，会把用户明确允许的构建静默改掉
})

test('mergeAllowBuilds：幂等 —— 重复执行不改变内容', () => {
  const once = mergeAllowBuilds('', BUILD_SCRIPT_DECISIONS)
  const twice = mergeAllowBuilds(once.text, BUILD_SCRIPT_DECISIONS)
  assert.equal(twice.text, once.text, '第二次不该有任何变化')
  assert.deepEqual(twice.added, [])
  assert.deepEqual(twice.kept.sort(), ['cpu-features', 'ssh2'])
  // 负对照：每次都追加 → 文件无限增长，YAML 里堆满重复段
})

test('mergeAllowBuilds：值必须是显式 false，不能是占位文本', () => {
  const result = mergeAllowBuilds('', BUILD_SCRIPT_DECISIONS)
  assert.ok(!result.text.includes('set this to'), '不能留下 pnpm 生成的占位提示')
  for (const [name, value] of Object.entries(BUILD_SCRIPT_DECISIONS)) {
    assert.equal(value, false, `${name} 的决定必须是明确的 false`)
    assert.match(result.text, new RegExp(`^\\s+${name}: false$`, 'm'))
  }
  // 负对照：把值写成 'set this to true or false'，pnpm 无法解析
})

test('readBundles：正常读出、缺字段/坏文件返回空数组', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['a', 'b'] } },
    }), 'utf8')
    assert.deepEqual(await readBundles(dir), ['a', 'b'])

    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8')
    assert.deepEqual(await readBundles(dir), [], '缺 dsh.profile.bundles → 空数组')

    await writeFile(join(dir, 'package.json'), '{ not json', 'utf8')
    assert.deepEqual(await readBundles(dir), [], '坏 JSON → 空数组而不是抛错')

    assert.deepEqual(await readBundles(join(dir, 'nope')), [], '目录不存在 → 空数组')
    // 负对照：不 catch，一个坏文件会把安装器的后校验整个打挂
  })
})

test('readBundles：能识别出「装了但没登记」', async () => {
  await withTempDir(async (dir) => {
    // 模拟实测到的失败状态：node_modules 里有插件，bundles 里没有
    await mkdir(join(dir, 'node_modules', '@jk-uzi', 'dsh-multi-remote'), { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }), 'utf8')

    const bundles = await readBundles(dir)
    assert.ok(!bundles.includes(PACKAGE_NAME), '这正是那个坑：装上了但没登记')
    // 负对照：只看 node_modules 是否存在就判定成功 → 会把「装了但不加载」报成成功
  })
})

test('parseArgs：默认值、显式值、错误处理', () => {
  const defaults = parseArgs([])
  assert.equal(defaults.profile, 'default')
  assert.equal(defaults.target, PACKAGE_NAME)
  assert.equal(defaults.dryRun, false)

  const explicit = parseArgs(['--profile', 'dev', '--target', 'link:.', '--dry-run'])
  assert.equal(explicit.profile, 'dev')
  assert.equal(explicit.target, 'link:.')
  assert.equal(explicit.dryRun, true)

  assert.equal(parseArgs(['-h']).help, true)
  assert.throws(() => parseArgs(['--profile']), /需要一个值/)
  assert.throws(() => parseArgs(['--bogus']), /未知参数/)
  // 负对照：不校验未知参数，打错字会被静默忽略（用户以为改了 profile，其实没有）
})

test('resolveDshHome：显式 > 环境变量 > ~/.dsh', () => {
  const saved = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    assert.ok(resolveDshHome(undefined).endsWith('.dsh'), '没有显式与环境变量时退回 ~/.dsh')

    process.env.DSH_HOME = join(tmpdir(), 'some-dsh-home')
    assert.equal(resolveDshHome(undefined), join(tmpdir(), 'some-dsh-home'), '环境变量优先于默认')

    assert.equal(resolveDshHome(join(tmpdir(), 'explicit')), join(tmpdir(), 'explicit'), '显式参数优先级最高')
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
  // 负对照：忽略 DSH_HOME，会往用户的 ~/.dsh 写东西（动了错误的 profile）
})
