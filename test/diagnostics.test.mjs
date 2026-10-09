/**
 * `src/diagnostics.js` 的契约测试。
 *
 * 这个模块只做一件事：回答「这台机器上，三种后端各自能不能用」。
 * 它的价值全在**诚实**上 —— 探不到就说探不到，不猜；
 * 也绝不把「能列出东西」说成「连得上」（那需要凭据，自检不该要凭据）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { probeSsh, probeWsl, probeDocker, probeBackends, listTargets } from '../src/diagnostics.js'

test('probeSsh：只报客户端能力，**不猜服务器能不能连**', async () => {
  const result = await probeSsh()
  assert.equal(result.status, 'client-ready')
  // 这条很重要：自检不该要凭据，也不该在用户没让你连的时候发连接。
  // 所以只能说「客户端可用」，不能说「你的服务器连得上」。
  assert.match(result.detail, /连接时才验证/)
  // 负对照：自检里真去连一台服务器 → 要么需要凭据（不该），要么发一堆无谓的连接
})

test('probeWsl：非 Windows 上如实报 unsupported', async () => {
  const result = await probeWsl({ platform: 'linux' })
  assert.equal(result.status, 'unsupported')
  assert.match(result.detail, /只在 Windows/)
  // 负对照：非 Windows 上去跑 wsl.exe → 报一个看不懂的 ENOENT
})

test('probeWsl：Windows 上列出发行版（真机）', { skip: process.platform !== 'win32' ? '仅 Windows' : false }, async () => {
  const result = await probeWsl()
  // 这台机器上装了 WSL，所以应当是 available；如果没装就应当是 unavailable（而不是崩）
  assert.ok(['available', 'unavailable', 'unknown'].includes(result.status), `实际：${result.status} ${result.detail}`)
  if (result.status === 'available') {
    assert.ok(Array.isArray(result.distros) && result.distros.length > 0)
    assert.ok(!result.distros.includes(''), '空行必须被过滤掉（实测 wsl -l -q 有空行）')
  }
  // 负对照：探测抛错时直接往上抛 → 整个自检 500，用户拿不到任何信息
})

test('probeDocker：守护进程在跑时报告版本与端点（真机）', async () => {
  const result = await probeDocker({ timeoutMs: 8000 })
  assert.ok(['available', 'unavailable', 'unknown'].includes(result.status), `实际：${result.status}`)
  if (result.status === 'available') {
    assert.ok(typeof result.apiVersion === 'string' && result.apiVersion !== '')
    assert.ok(typeof result.endpoint === 'string' && result.endpoint !== '', '应当报出实际用的端点')
    assert.equal(result.osType, 'linux')
  } else {
    // 探不到时必须带上原始错误，不能只说一句「失败」
    assert.ok(typeof result.detail === 'string' && result.detail !== '')
  }
  // 负对照：探测失败时吞掉原因 → 用户不知道是没启动还是端点不对
})

test('probeDocker：端点不可用时报 unavailable 并列出试过哪些端点', async () => {
  const result = await probeDocker({
    timeoutMs: 3000,
    dockerClientOptions: { env: { DOCKER_HOST: 'npipe:////./pipe/definitely-not-real' } },
  })
  assert.equal(result.status, 'unavailable')
  assert.match(result.detail, /Docker Desktop|连不上/)
  assert.deepEqual(result.endpoints, ['\\\\.\\pipe\\definitely-not-real'])
  // 负对照：不报端点 → 用户不知道我们在找哪个管道/socket
})

test('probeDocker：DOCKER_HOST 是 tcp:// 时如实报不支持', async () => {
  const result = await probeDocker({
    timeoutMs: 3000,
    dockerClientOptions: { env: { DOCKER_HOST: 'tcp://1.2.3.4:2375' } },
  })
  assert.equal(result.status, 'unavailable')
  assert.match(result.detail, /tcp:\/\/ 与 ssh:\/\//)
  // 负对照：报一句笼统的「连不上」→ 用户去查 Docker Desktop，而问题在 DOCKER_HOST
})

test('probeBackends：三个后端一起探，且任何一个失败不影响其他', async () => {
  const result = await probeBackends()
  assert.deepEqual(Object.keys(result).sort(), ['docker', 'ssh', 'wsl'])
  for (const [name, entry] of Object.entries(result)) {
    assert.ok(typeof entry.status === 'string' && entry.status !== '', `${name} 必须有 status`)
    assert.ok(typeof entry.detail === 'string', `${name} 必须有 detail`)
  }
  // 负对照：串行探测 → 自检白等三倍时间（三个探测互不依赖）
})

test('probeBackends：并行而不是串行（三个慢探测不该累加）', async () => {
  // 用一个慢的 Docker 探测 + 快的其他两个来验证并行性。
  // 串行的话总耗时会是三者之和；并行的话接近最慢那个。
  const t0 = Date.now()
  await probeBackends({ timeoutMs: 1200, dockerClientOptions: { env: { DOCKER_HOST: 'npipe:////./pipe/nope' } } })
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 3000, `三个探测应当并行，实际花了 ${elapsed}ms`)
  // 负对照：await 逐个探 → 耗时累加
})

// ── listTargets：界面用的「有哪些可以点」────────────────────────────────────

test('listTargets：WSL 发行版**全列出来**，系统发行版只标记不隐藏', async () => {
  // 用户提醒 + 项目原则：`docker-desktop` 是**货真价实的 WSL2 发行版**
  // （注册表 `Lxss` 里有 BasePath、`wsl -l -v` 列得出来）——
  // 隐藏它会让列表和 `wsl -l -q` 对不上，用户会以为插件漏了；
  // 而且「按名字硬编码地隐藏」换个工具就漏判。
  const all = ['Ubuntu-24.04', 'docker-desktop', 'docker-desktop-data', 'Debian']
  const targets = await listTargets({ platform: 'win32', listDistros: async () => all })
  assert.deepEqual(targets.wsl.distros, all, '列表必须与 wsl -l -q 一致（一个都不能少）')
  assert.deepEqual(targets.wsl.systemDistros, ['docker-desktop', 'docker-desktop-data'], '系统发行版要标出来')
  assert.match(targets.wsl.detail, /找到 4 个发行版/)
  // 负对照：直接隐藏 → 用户 `wsl -l -q` 看到 4 个、插件只给 2 个，以为插件坏了
})

test('listTargets：只剩系统发行版时在说明里点出来（但照样列出来）', async () => {
  const targets = await listTargets({ platform: 'win32', listDistros: async () => ['docker-desktop'] })
  assert.deepEqual(targets.wsl.distros, ['docker-desktop'], '仍然要列出来')
  assert.deepEqual(targets.wsl.systemDistros, ['docker-desktop'])
  assert.match(targets.wsl.detail, /只有 Docker Desktop 的系统发行版/)
  // 负对照：报「找到 1 个发行版」→ 用户以为有个能用的，点进去发现是 Docker 的 VM
})

test('listTargets：非 Windows 上 WSL 报 unsupported，形状仍然完整', async () => {
  let called = false
  const targets = await listTargets({
    platform: 'linux',
    listDistros: async () => { called = true; return [] },
  })
  assert.equal(targets.wsl.status, 'unsupported')
  assert.deepEqual(targets.wsl.distros, [])
  assert.deepEqual(targets.wsl.systemDistros, [])
  assert.equal(called, false, '非 Windows 上不该去跑 wsl.exe')
  // 负对照：非 Windows 也去跑 → 一个看不懂的 ENOENT
})

test('listTargets：探测抛错时收敛成 unknown，绝不往上抛', async () => {
  const targets = await listTargets({
    platform: 'win32',
    listDistros: async () => { throw new Error('wsl.exe 没了') },
  })
  assert.equal(targets.wsl.status, 'unknown')
  assert.match(targets.wsl.detail, /wsl\.exe 没了/)
  assert.deepEqual(targets.wsl.distros, [])
  // 负对照：抛上去 → 弹窗整个白屏（探测失败不该让界面挂掉）
})
