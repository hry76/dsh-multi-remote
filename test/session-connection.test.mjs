/**
 * `src/session/profile.js` 与 `src/session/connection.js` 的契约测试。
 *
 * 重点：
 *   - 档案校验**不猜不补全**（猜错远程根/锚点会把镜像写到意外的地方）
 *   - 凭据**绝不回显**（describeProfile 是唯一的出口）
 *   - 连接编排的失败路径**把资源收干净**，不留半截状态
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeProfile, describeProfile, findLeakedSecrets, ProfileError, anchorPathOf } from '../src/session/profile.js'
import { ROOT_CHECK_MARKER } from '../src/session/verify-root.js'
import { ConnectionManager, RemoteWorkspace, defaultAnchorParent } from '../src/session/connection.js'
import { PresetRegistry } from '../src/session/preset.js'
import { registeredProfileIds, clearTransports } from '../src/transport/registry.js'
import { TRANSPORT_ERROR, TransportError } from '../src/transport/transport.js'

const SECRET = 'super-secret-password-xyz'

/** 一份合法档案。 */
function validProfile(overrides = {}) {
  return {
    id: 'conn-1',
    host: 'example.invalid',
    username: 'user',
    privateKeyPath: '/home/user/.ssh/id_ed25519',
    remoteRoot: '/home/user/proj',
    anchorParent: join(tmpdir(), 'anchors'),
    ...overrides,
  }
}

/** 假 transport：可控地成功或失败。 */
function fakeTransport(options = {}) {
  const files = options.files ?? { 'README.md': '# remote\n', 'src/app.js': 'x\n' }
  const dirs = new Map([['', new Map()]])
  const ensure = (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, new Map())
    return dirs.get(dir)
  }
  for (const [rel, content] of Object.entries(files)) {
    const segments = rel.split('/')
    for (let i = 0; i < segments.length; i += 1) {
      const children = ensure(segments.slice(0, i).join('/'))
      if (i === segments.length - 1) {
        children.set(segments[i], { name: segments[i], type: 'file', size: Buffer.byteLength(content, 'utf8'), mtimeMs: 1_700_000_000_000 })
      } else {
        children.set(segments[i], { name: segments[i], type: 'directory', mtimeMs: 1_700_000_000_000 })
        ensure(segments.slice(0, i + 1).join('/'))
      }
    }
  }
  const root = options.remoteRoot ?? '/home/user/proj'
  const toRel = (path) => {
    if (path === root) return ''
    if (!path.startsWith(`${root}/`)) {
      throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `假远程只提供 ${root}`, { operation: 'readdir', target: path })
    }
    return path.slice(root.length + 1)
  }

  return {
    kind: 'ssh',
    connectCalls: 0,
    disconnectCalls: 0,
    observedFingerprint: 'fp-test',
    async connect() {
      this.connectCalls += 1
      if (options.connectFails === true) {
        throw new TransportError(TRANSPORT_ERROR.AUTH_FAILED, '认证失败', { operation: 'connect', retryable: false })
      }
    },
    async disconnect() {
      this.disconnectCalls += 1
    },
    async testConnection() {
      return { ok: true }
    },
    async realpath(path) {
      return path
    },
    async stat(path) {
      const rel = toRel(path)
      if (rel === '') return { type: 'directory', size: 0, mtimeMs: 1_700_000_000_000 }
      const entry = dirs.get(rel.split('/').slice(0, -1).join('/'))?.get(rel.split('/').at(-1))
      if (entry === undefined) {
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `不存在 ${path}`, { operation: 'stat', target: path })
      }
      return { type: entry.type, size: entry.size ?? 0, mtimeMs: entry.mtimeMs }
    },
    async readdir(path) {
      const children = dirs.get(toRel(path))
      if (children === undefined) {
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `不存在 ${path}`, { operation: 'readdir', target: path })
      }
      return [...children.values()]
    },
    async readFile(path) {
      const content = files[toRel(path)]
      if (content === undefined) {
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `不存在 ${path}`, { operation: 'readFile', target: path })
      }
      return content
    },
    async writeFileAtomic() {},
    async exec(command) {
      // 连接前会探测「远程项目根是否存在」（见 src/session/verify-root.js）。
      // 假机器要如实回答「存在」—— 不回答的话连接会被**正确**拦下
      // （报「远程目录不存在」），那是产品行为，不是这些用例要验的东西。
      if (String(command).includes(ROOT_CHECK_MARKER)) {
        return { code: 0, stdout: 'OK\nPARENT_OK\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

/** 假 agentPresets（含 compositionInventory）。 */
function fakeAgentPresets(options = {}) {
  const definitions = new Map()
  const broken = new Set(options.brokenIds ?? [])
  return {
    broken,
    selectCalls: [],
    async register(definition) {
      if (definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
      definitions.set(definition.id, definition)
      return async () => definitions.delete(definition.id)
    },
    async compositionInventory() {
      return [...definitions.keys()].map((id) => ({
        id,
        isDefault: false,
        ...broken.has(id) ? { broken: 'row never started' } : {},
        rows: broken.has(id) ? [] : [{ id: `${id}-world`, state: 'active' }],
      }))
    },
    async resolve(id) {
      if (!definitions.has(id)) {
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `未知预设 ${id}`, { operation: 'resolve' })
      }
      return { id, ...broken.has(id) ? { broken: 'row never started' } : {} }
    },
    async select(agent, presetId) {
      this.selectCalls.push([agent.id, presetId])
      if (!definitions.has(presetId)) throw new Error(`agent-preset/not-found: ${presetId}`)
    },
    composedPreset() {
      return options.composedPreset
    },
  }
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'session-test-'))
  try {
    return await fn(dir)
  } finally {
    clearTransports()
    await rm(dir, { recursive: true, force: true })
  }
}

// ── profile ─────────────────────────────────────────────────────────────────

test('normalizeProfile：合法档案通过，默认值被补上', () => {
  const profile = normalizeProfile(validProfile())
  assert.equal(profile.port, 22, 'port 默认 22')
  assert.equal(profile.tryKeyboard, false)
  assert.equal(profile.label, 'conn-1', '没给 label 就用 id')
  // 负对照：不补默认 port，连接会打到 undefined
})

test('normalizeProfile：不猜不补全，缺什么报什么', () => {
  const problems = (input) => {
    try {
      normalizeProfile(input)
      return []
    } catch (error) {
      assert.ok(error instanceof ProfileError)
      return error.problems
    }
  }

  assert.match(problems(validProfile({ remoteRoot: 'home/user/proj' })).join(), /必须是以 \/ 开头/)
  assert.match(problems(validProfile({ remoteRoot: '' })).join(), /remoteRoot 必填/)
  assert.match(problems(validProfile({ anchorParent: 'relative/path' })).join(), /anchorParent 必须是绝对路径/)
  assert.match(problems(validProfile({ id: 'a.b' })).join(), /不能含点号/)
  assert.match(problems(validProfile({ host: '' })).join(), /host 必填/)
  assert.match(problems(validProfile({ username: '' })).join(), /username 必填/)
  assert.match(problems(validProfile({ port: 99999 })).join(), /port 必须是/)
  assert.match(
    problems(validProfile({ privateKeyPath: undefined, privateKey: undefined })).join(),
    /至少要提供一种认证方式/,
  )
  // 负对照：把相对 remoteRoot 补成 `/home/user/...`，镜像会写到用户完全没预期的位置
})

test('normalizeProfile：机器级档案（machine: true）没有项目根也算合法', () => {
  // 界面里「用过的连接」存的就是这种：只记「连过哪台机器」。
  // 项目根是第二步（看着远程目录点选）才有的。
  // ⚠️ 以前两步流程**一条都不存**，于是「用过的连接」永远是空的（用户实测反馈）。
  const profile = normalizeProfile({
    id: 'ssh-user-10-0-0-5-22',
    kind: 'ssh',
    host: '10.0.0.5',
    username: 'user',
    privateKeyPath: '~/.ssh/id_ed25519',
    machine: true,
  })
  assert.equal(profile.machine, true)
  assert.equal(profile.remoteRoot, undefined, '机器级档案没有项目根')
  assert.equal(profile.anchorParent, undefined)

  // 但**非**机器级档案仍然必须给项目根 —— 否则锚点目录会算到一个空路径上
  const problems = (input) => {
    try { normalizeProfile(input); return [] } catch (error) { return error.problems }
  }
  assert.match(
    problems({ id: 'x', kind: 'ssh', host: 'h', username: 'u', privateKeyPath: 'k' }).join(),
    /remoteRoot 必填/,
  )
  // 负对照：为了「少填一项」把 remoteRoot 全局改成可选 → 连接档案可以没有项目根
})

test('normalizeProfile：多问题一次性全报，而不是挤牙膏', () => {  try {
    normalizeProfile({ id: '', host: '', username: '', remoteRoot: 'x', anchorParent: 'y' })
    assert.fail('应当抛错')
  } catch (error) {
    assert.ok(error.problems.length >= 5, `应当一次报全，实际 ${error.problems.length} 条：${error.problems.join('；')}`)
  }
  // 负对照：遇错即 return，用户要改五轮才知道全部问题
})

// ── WSL 档案（M2） ──────────────────────────────────────────────────────────

test('normalizeProfile：WSL 档案不需要任何凭据，只要发行版名', () => {
  const profile = normalizeProfile({
    id: 'wsl-1',
    kind: 'wsl',
    distro: 'Ubuntu-24.04',
    remoteRoot: '/home/user/proj',
    anchorParent: join(tmpdir(), 'anchors'),
  })
  assert.equal(profile.kind, 'wsl')
  assert.equal(profile.distro, 'Ubuntu-24.04')
  // SSH 专属字段不该残留半截
  assert.equal(profile.host, undefined)
  assert.equal(profile.port, undefined)
  assert.equal(profile.username, undefined)
  assert.equal(profile.password, undefined)
  // 负对照：WSL 也要求「至少一种认证方式」→ 用户会被逼着填根本不存在的凭据
})

test('normalizeProfile：kind 缺省是 ssh（向后兼容已有档案）', () => {
  const profile = normalizeProfile(validProfile())
  assert.equal(profile.kind, 'ssh')
  assert.equal(profile.host, 'example.invalid')
  // 负对照：缺省不是 ssh → 升级后已有档案全部失效
})

test('normalizeProfile：kind 非法要报错，不做猜测', () => {
  try {
    normalizeProfile({ ...validProfile(), kind: 'kubernetes' })
    assert.fail('应当抛错')
  } catch (error) {
    assert.match(error.problems.join(), /kind 只支持/)
  }
  // 负对照：未知 kind 静默当成 ssh → 会连到完全不同的地方
})

test('normalizeProfile：Docker 档案不需要任何凭据，只要容器名', () => {
  const profile = normalizeProfile({
    id: 'dock-1',
    kind: 'docker',
    container: 'my-app',
    remoteRoot: '/app',
    anchorParent: join(tmpdir(), 'anchors'),
  })
  assert.equal(profile.kind, 'docker')
  assert.equal(profile.container, 'my-app')
  assert.equal(profile.host, undefined)
  assert.equal(profile.username, undefined)
  assert.equal(profile.password, undefined)
  // 负对照：Docker 也要求认证 → 用户被逼着填根本不存在的凭据
})

test('normalizeProfile：Docker 缺 container 要报错', () => {
  try {
    normalizeProfile({ id: 'd', kind: 'docker', remoteRoot: '/app', anchorParent: join(tmpdir(), 'a') })
    assert.fail('应当抛错')
  } catch (error) {
    assert.match(error.problems.join(), /container 必填/)
  }
  // 负对照：container 为空 → 每个操作都失败在深处，指不到根因
})

test('describeProfile：Docker 描述里只有容器名，没有凭据', () => {
  const profile = normalizeProfile({
    id: 'dock-1', kind: 'docker', container: 'my-app',
    remoteRoot: '/app', anchorParent: join(tmpdir(), 'anchors'),
  })
  const described = describeProfile(profile)
  assert.equal(described.kind, 'docker')
  assert.equal(described.container, 'my-app')
  assert.equal(described.host, undefined)
  assert.match(described.auth.note, /不需要凭据/)
  // 负对照：套 SSH 的 auth 结构 → 界面显示一堆 null
})

test('normalizeProfile：WSL 缺 distro 要报错', () => {
  try {
    normalizeProfile({ id: 'w', kind: 'wsl', remoteRoot: '/r', anchorParent: join(tmpdir(), 'a') })
    assert.fail('应当抛错')
  } catch (error) {
    assert.match(error.problems.join(), /distro 必填/)
  }
  // 负对照：distro 为空 → 每个操作都失败在深处，指不到根因
})

test('describeProfile：WSL 描述里没有 host/凭据，只有发行版', () => {
  const profile = normalizeProfile({
    id: 'wsl-1', kind: 'wsl', distro: 'Ubuntu-24.04',
    remoteRoot: '/home/user/proj', anchorParent: join(tmpdir(), 'anchors'),
  })
  const described = describeProfile(profile)
  assert.equal(described.kind, 'wsl')
  assert.equal(described.distro, 'Ubuntu-24.04')
  assert.equal(described.host, undefined)
  assert.equal(described.auth.kind, 'wsl')
  assert.match(described.auth.note, /不需要凭据/)
  // 负对照：把 SSH 的 auth 结构套给 WSL → 界面会显示一堆 null 字段
})

test('describeProfile：凭据绝不回显', () => {
  const profile = normalizeProfile(validProfile({ password: SECRET, passphrase: SECRET, privateKey: 'KEYDATA' }))
  const described = describeProfile(profile)
  const json = JSON.stringify(described)

  assert.ok(!json.includes(SECRET), '口令绝不能出现在描述里')
  assert.ok(!json.includes('KEYDATA'), '私钥内容绝不能出现在描述里')
  assert.equal(described.auth.password, '(已配置，不回显)')
  assert.equal(described.host, 'example.invalid', '非敏感字段照常给出')
  // 负对照：直接把 profile 序列化出去，口令与私钥会一起泄漏
})

test('findLeakedSecrets：能抓出口令泄漏', () => {
  const profile = normalizeProfile(validProfile({ password: SECRET }))
  assert.deepEqual(findLeakedSecrets('一切正常', profile), [])
  assert.deepEqual(findLeakedSecrets(`连接失败，密码 ${SECRET} 不对`, profile), ['password'])
  // 负对照：不做这个检查，日志里泄了口令也没人发现
})

test('anchorPathOf / defaultAnchorParent：路径拼装', () => {
  const profile = normalizeProfile(validProfile())
  assert.equal(anchorPathOf(profile, 'mr-conn-1-abc'), join(profile.anchorParent, 'mr-conn-1-abc'))
  assert.ok(defaultAnchorParent().includes('.dsh-multi-remote'), '默认锚点放在 ~/.dsh-multi-remote/anchors')
  // 负对照：无
})

// ── connection ──────────────────────────────────────────────────────────────

test('ConnectionManager.connect：成功时建镜像、注册预设、返回报告', async () => {
  await withTempDir(async (dir) => {
    const agentPresets = fakeAgentPresets()
    const registry = new PresetRegistry({ agentPresets })
    const manager = new ConnectionManager({
      agentPresets,
      presetRegistry: registry,
      createTransport: () => fakeTransport(),
    // 后台补拉会异步往锚点写文件，与测试的临时目录清理打架；
    // 它是独立特性，另有专门测试覆盖（test/mirror-deepen.test.mjs）。
    deepenEnabled: false,
    })

    const workspace = await manager.connect(validProfile({ anchorParent: dir }))
    assert.equal(workspace.connected, true)
    assert.ok(workspace.anchorPath.startsWith(dir), `锚点应在 anchorParent 下：${workspace.anchorPath}`)
    assert.equal(workspace.presetId, registry.registeredIds[0], '预设应当注册好了')
    assert.ok(registeredProfileIds().includes('conn-1'), 'transport 应当已注册（隔离域靠它取远程）')

    // 镜像真的拉下来了
    const { readFile } = await import('node:fs/promises')
    assert.equal(await readFile(join(workspace.anchorPath, 'README.md'), 'utf8'), '# remote\n')

    await manager.disconnect('conn-1')
    assert.deepEqual(registeredProfileIds(), [], '断开后 transport 应当注销')
    assert.deepEqual(registry.registeredIds, [], '断开后预设应当注销')
    // 负对照：断开不注销预设，重连会撞 Duplicate agent preset
  })
})

test('ConnectionManager.connect：连接失败时不留半截状态', async () => {
  await withTempDir(async (dir) => {
    const agentPresets = fakeAgentPresets()
    const registry = new PresetRegistry({ agentPresets })
    const transport = fakeTransport({ connectFails: true })
    const manager = new ConnectionManager({
      agentPresets,
      presetRegistry: registry,
      createTransport: () => transport,
    deepenEnabled: false,
    })

    await assert.rejects(
      () => manager.connect(validProfile({ anchorParent: dir })),
      (error) => {
        assert.equal(error.code, TRANSPORT_ERROR.AUTH_FAILED, '错误码要透出来，便于给可执行提示')
        return true
      },
    )
    assert.equal(manager.get('conn-1'), undefined, '失败后不该留在表里')
    assert.deepEqual(registeredProfileIds(), [], '失败后 transport 不该残留')
    assert.deepEqual(registry.registeredIds, [], '失败后预设不该残留')
    // 负对照：catch 里不清理，注册表里会留下一个指向死连接的档案 ——
    // 之后同名重连会被「已经注册过」挡住，用户只能重启
  })
})

test('ConnectionManager.connect：预设激活失败时拒绝连接（绝不静默降级）', async () => {
  await withTempDir(async (dir) => {
    const agentPresets = fakeAgentPresets()
    const registry = new PresetRegistry({ agentPresets })
    const manager = new ConnectionManager({
      agentPresets,
      presetRegistry: registry,
      createTransport: () => fakeTransport(),
    // 后台补拉会异步往锚点写文件，与测试的临时目录清理打架；
    // 它是独立特性，另有专门测试覆盖（test/mirror-deepen.test.mjs）。
    deepenEnabled: false,
    })

    // 让这个档案派生出的预设 id 一定「激活失败」
    const profile = validProfile({ anchorParent: dir })
    const { presetIdFor } = await import('../src/session/preset.js')
    agentPresets.broken.add(presetIdFor(profile.id, profile.remoteRoot))

    await assert.rejects(
      () => manager.connect(profile),
      (error) => {
        assert.match(error.message, /拒绝让会话在本机降级运行/)
        return true
      },
    )
    assert.deepEqual(registeredProfileIds(), [], '失败要收干净')
    assert.equal(manager.get('conn-1'), undefined)
    // 负对照：不检查 diagnostic.usable，连接会「成功」，而用户的会话其实在本机跑
  })
})

test('ConnectionManager：重复连接同一档案直接拒绝', async () => {
  await withTempDir(async (dir) => {
    const agentPresets = fakeAgentPresets()
    const registry = new PresetRegistry({ agentPresets })
    const manager = new ConnectionManager({
      agentPresets,
      presetRegistry: registry,
      createTransport: () => fakeTransport(),
    // 后台补拉会异步往锚点写文件，与测试的临时目录清理打架；
    // 它是独立特性，另有专门测试覆盖（test/mirror-deepen.test.mjs）。
    deepenEnabled: false,
    })
    await manager.connect(validProfile({ anchorParent: dir }))
    await assert.rejects(
      () => manager.connect(validProfile({ anchorParent: dir })),
      /已经连接/,
    )
    // 负对照：允许重复连接，第二次会静默覆盖 transport 注册表 → 命令可能发往错误的机器
  })
})

test('ConnectionManager.findByAnchor：按锚点目录找到工作区，大小写不敏感', async () => {
  await withTempDir(async (dir) => {
    const agentPresets = fakeAgentPresets()
    const registry = new PresetRegistry({ agentPresets })
    const manager = new ConnectionManager({
      agentPresets,
      presetRegistry: registry,
      createTransport: () => fakeTransport(),
    // 后台补拉会异步往锚点写文件，与测试的临时目录清理打架；
    // 它是独立特性，另有专门测试覆盖（test/mirror-deepen.test.mjs）。
    deepenEnabled: false,
    })
    const workspace = await manager.connect(validProfile({ anchorParent: dir }))

    assert.equal(manager.findByAnchor(workspace.anchorPath), workspace)
    assert.equal(manager.findByAnchor(workspace.anchorPath.toUpperCase()), workspace, 'Windows 上大小写不敏感')
    assert.equal(manager.findByAnchor(join(dir, 'other')), undefined, '别的目录不是远程会话')
    assert.equal(manager.findByAnchor(undefined), undefined)
    // 负对照：大小写敏感匹配在 Windows 上会漏判 → 会话被判成本地会话，静默在本机跑
  })
})

test('ConnectionManager.disconnectAll：一次收干净，幂等', async () => {
  await withTempDir(async (dir) => {
    const agentPresets = fakeAgentPresets()
    const registry = new PresetRegistry({ agentPresets })
    const manager = new ConnectionManager({
      agentPresets,
      presetRegistry: registry,
      createTransport: () => fakeTransport(),
    // 后台补拉会异步往锚点写文件，与测试的临时目录清理打架；
    // 它是独立特性，另有专门测试覆盖（test/mirror-deepen.test.mjs）。
    deepenEnabled: false,
    })
    await manager.connect(validProfile({ id: 'c1', anchorParent: dir }))
    await manager.connect(validProfile({ id: 'c2', anchorParent: dir, remoteRoot: '/home/user/other' }))

    const summary = await manager.disconnectAll()
    assert.equal(summary.removed, 2)
    assert.equal(summary.failed, 0)
    assert.deepEqual(registeredProfileIds(), [])
    assert.deepEqual(registry.registeredIds, [])
    assert.equal(await manager.disconnect('c1'), false, '重复断开返回 false，不抛错')
    // 负对照：串行 await 不 catch，第一个失败会让后面的连接残留
  })
})

test('RemoteWorkspace.describe：不泄漏凭据，且给出锚点与预设状态', async () => {
  await withTempDir(async (dir) => {
    const agentPresets = fakeAgentPresets()
    const registry = new PresetRegistry({ agentPresets })
    const manager = new ConnectionManager({
      agentPresets,
      presetRegistry: registry,
      createTransport: () => fakeTransport(),
    // 后台补拉会异步往锚点写文件，与测试的临时目录清理打架；
    // 它是独立特性，另有专门测试覆盖（test/mirror-deepen.test.mjs）。
    deepenEnabled: false,
    })
    const workspace = await manager.connect(validProfile({ anchorParent: dir, password: SECRET }))
    const described = workspace.describe()

    assert.ok(!JSON.stringify(described).includes(SECRET), '连接概览里绝不能带口令')
    assert.equal(described.connected, true)
    assert.equal(described.presetUsable, true)
    assert.ok(described.anchorPath)
    // 负对照：list() 直接返回 profile，口令会进工具输出
  })
})
