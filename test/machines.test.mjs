/**
 * 「先连机器、再选文件夹」流程的契约测试（`src/session/machines.js`）。
 *
 * ## 为什么有这条流程
 *
 * 原来的「一次填完」要求用户**盲填远程项目根**。真机事故：用户填成
 * `/home/user/新建文件夹`（真实位置是 `/home/user/桌面/新建文件夹`），
 * 连接照样「成功」，之后每条命令都切不到目录 —— 排查非常费劲。
 *
 * 用户提的流程更对（也是 VS Code / ZCode 的做法）：
 * 先连机器 → **看着远程真实目录点选** → 它成为工作区。路径不再靠猜。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MachineRegistry, deriveMachineId, normalizeMachineInput, describeMachine } from '../src/session/machines.js'
import { TRANSPORT_ERROR, TransportError } from '../src/transport/transport.js'

/** 假传输层：能连、能列目录、能 exec。 */
function fakeTransport(options = {}) {
  return {
    connected: false,
    disconnected: 0,
    async connect() {
      this.connected = true
    },
    async disconnect() {
      this.disconnected += 1
      this.connected = false
    },
    async exec(command) {
      if (String(command).includes('HOME')) return { code: 0, stdout: options.home ?? '/home/user\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
    async readdir(path) {
      if (options.missing?.includes(path)) {
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `不存在 ${path}`, { operation: 'readdir', target: path })
      }
      return options.entries ?? []
    },
  }
}

function registryWith(transport) {
  return new MachineRegistry({ createTransport: () => transport })
}

// ── 纯逻辑 ──────────────────────────────────────────────────────────────────

test('deriveMachineId：后端 + 目标 → 合法 id（不能含点号）', () => {
  assert.equal(deriveMachineId('ssh', 'user@10.0.0.5:22'), 'ssh-user-10-0-0-5-22')
  assert.equal(deriveMachineId('wsl', 'Ubuntu-24.04'), 'wsl-ubuntu-24-04')
  assert.equal(deriveMachineId('docker', 'my.container_1'), 'docker-my-container-1')
  assert.ok(!deriveMachineId('ssh', '1.2.3.4').includes('.'), 'id 绝不能含点号（会进预设 id）')
  // 负对照：id 含点号 → 预设 id 非法 → 插件树加载失败（实测踩过）
})

test('normalizeMachineInput：**不要求**远程项目根，但按后端校验必填', () => {
  const ssh = normalizeMachineInput({ kind: 'ssh', host: 'h', username: 'u', privateKeyPath: '/k' })
  assert.equal(ssh.kind, 'ssh')
  assert.equal(ssh.port, 22, '默认端口')
  assert.equal(ssh.remoteRoot, undefined, '连机器这一步不该有 remoteRoot')

  assert.throws(() => normalizeMachineInput({ kind: 'wsl' }), /缺少必填字段：distro/)
  assert.throws(() => normalizeMachineInput({ kind: 'docker' }), /缺少必填字段：container/)
  assert.throws(() => normalizeMachineInput({ kind: 'ssh', host: 'h' }), /缺少必填字段：username/)
  // SSH 还必须有认证方式 —— 否则连上也会立刻失败
  assert.throws(
    () => normalizeMachineInput({ kind: 'ssh', host: 'h', username: 'u' }),
    /至少要提供一种认证方式/,
  )
  assert.throws(() => normalizeMachineInput({ kind: 'telnet', host: 'h' }), /不支持的后端类型/)
  // 负对照：不校验认证 → 用户填完点连接，报错来自 SSH 库深处，看不懂
})

test('normalizeMachineInput：白名单，不认识与敏感之外一律丢掉', () => {
  const input = normalizeMachineInput({
    kind: 'wsl', distro: 'Ubuntu-24.04',
    command: 'rm -rf /', remoteRoot: '/etc', __proto__: { polluted: true }, extra: { deep: 1 },
  })
  assert.deepEqual(Object.keys(input).sort(), ['distro', 'kind'])
  assert.equal(input.command, undefined)
  assert.equal(input.remoteRoot, undefined, '连机器阶段不接受项目根（那是第二步的事）')
  // 负对照：整包透传 → 界面能往连接内部塞任意字段
})

// ── 连机器 ──────────────────────────────────────────────────────────────────

test('连机器：连上后返回 id / 目标 / 起始目录', async () => {
  const transport = fakeTransport({ home: '/home/user\n' })
  const registry = registryWith(transport)
  const machine = await registry.connect({ kind: 'ssh', host: '10.0.0.5', username: 'user', privateKeyPath: '/k' })

  assert.equal(transport.connected, true)
  assert.equal(machine.id, 'ssh-user-10-0-0-5-22')
  assert.equal(machine.target, 'user@10.0.0.5:22')
  assert.equal(machine.home, '/home/user', '起始目录取远程 $HOME')
  // 负对照：不取 HOME → 用户从一个猜出来的路径开始浏览
})

test('连机器：拿不到 $HOME 也不失败，退回根目录（不猜假路径）', async () => {
  const transport = fakeTransport({ home: '' })
  const registry = registryWith(transport)
  const machine = await registry.connect({ kind: 'wsl', distro: 'Ubuntu-24.04' })
  assert.equal(machine.home, '/', '拿不到就老实退回 /')
  // 负对照：编一个 /home/<猜的用户名> → 浏览第一屏就是「目录不存在」
})

test('连机器：同一台机器重复连 → 复用，不报错也不重复建连接', async () => {
  const transport = fakeTransport()
  const registry = registryWith(transport)
  const first = await registry.connect({ kind: 'wsl', distro: 'Ubuntu-24.04' })
  const second = await registry.connect({ kind: 'wsl', distro: 'Ubuntu-24.04' })
  assert.deepEqual(second, first)
  assert.equal(registry.list().length, 1, '只应有一条机器连接')
  // 负对照：重复连直接报错 → 用户多点一次「连接」就以为坏了
})

// ── 浏览目录 ────────────────────────────────────────────────────────────────

test('列目录：目录在前、文件只给数量、上层路径本地算', async () => {
  const transport = fakeTransport({
    home: '/home/user\n',
    entries: [
      { name: 'z.txt', type: 'file' },
      { name: '桌面', type: 'directory' },
      { name: 'abc', type: 'directory' },
      { name: '.', type: 'directory' },
      { name: '..', type: 'directory' },
      { name: 'a.txt', type: 'file' },
    ],
  })
  const registry = registryWith(transport)
  await registry.connect({ kind: 'wsl', distro: 'Ubuntu-24.04' })
  const listing = await registry.listDir('wsl-ubuntu-24-04')

  assert.equal(listing.path, '/home/user', '不传路径就从 $HOME 开始')
  assert.equal(listing.parent, '/home')
  // 只钉「目录都在、文件不算进来」，**不钉具体顺序** ——
  // 中英混排的排序规则（`localeCompare` 按拼音）不是这条测试要管的事
  assert.deepEqual([...listing.dirs.map((d) => d.name)].sort(), ['abc', '桌面'].sort())
  assert.ok(listing.dirs.every((d) => d.type === 'dir'), '目录列表里不能混进文件')
  assert.equal(listing.fileCount, 2, '文件只回数量（用户是来选文件夹的）')
  // 负对照：把文件名全列出来 → 一个大目录直接把界面刷屏
})

test('列目录：根目录的上层是 null（不能无限往上点）', async () => {
  const registry = registryWith(fakeTransport({ entries: [] }))
  await registry.connect({ kind: 'wsl', distro: 'Ubuntu-24.04' })
  const listing = await registry.listDir('wsl-ubuntu-24-04', '/')
  assert.equal(listing.parent, null)
  // 负对照：parent 给 '/' → 用户点「上一层」原地打转
})

test('列目录：目录不存在要给看得懂的话，不是底层错误码', async () => {
  const registry = registryWith(fakeTransport({ missing: ['/home/user/没有这个'] }))
  await registry.connect({ kind: 'wsl', distro: 'Ubuntu-24.04' })
  await assert.rejects(
    () => registry.listDir('wsl-ubuntu-24-04', '/home/user/没有这个'),
    /目录不存在：\/home\/user\/没有这个/,
  )
  // 负对照：把 TransportError 直接抛给界面 → 用户看到一串英文错误码
})

test('列目录：机器已断开时说清楚要重连', async () => {
  const registry = registryWith(fakeTransport())
  await assert.rejects(
    () => registry.listDir('不存在的机器', '/'),
    /没有名为 不存在的机器 的已连接机器/,
  )
  // 负对照：静默返回空列表 → 用户以为那台机器上一个文件夹都没有
})

// ── 断开 ────────────────────────────────────────────────────────────────────

test('断开：幂等，且一台失败不影响其他', async () => {
  const transports = [fakeTransport(), fakeTransport()]
  let index = 0
  const logs = []
  const registry = new MachineRegistry({ createTransport: () => transports[index++], log: (message) => logs.push(String(message)) })
  await registry.connect({ kind: 'wsl', distro: 'A' })
  await registry.connect({ kind: 'wsl', distro: 'B' })

  transports[0].disconnect = async () => {
    throw new Error('断开时通道已死')
  }
  const count = await registry.disconnectAll()
  // 断开**失败**的那台也算已断开：连接断了就是断了，只是记一条日志。
  // 关键是「表要清空」——否则重挂载时残留旧连接，命令可能发往错误的机器。
  assert.equal(count, 2)
  assert.equal(registry.list().length, 0, '表要清空')
  assert.ok(logs.some((line) => line.includes('断开机器')), '失败要留痕，不能静默')
  assert.equal(await registry.disconnect('已经不在的'), false, '重复断开不抛错')
  // 负对照：一台断开失败就中断 → 后面的机器永远挂着
})
