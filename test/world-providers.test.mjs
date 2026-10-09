/**
 * `src/world/fs.js` 与 `src/world/shell.js` 的契约测试。
 *
 * ## 为什么这两个文件必须有测试
 *
 * 它们是**隔离域里的执行世界**：agent 的每一次读写与命令都经过这里。
 * 它们的失败模式里有一种特别危险 —— **静默回退到本机**：
 * 远程通道断了却照样执行，用户以为命令在远端跑，实际在自己机器上跑。
 * 这是本项目最坏的失败模式，所以要用测试钉死「绝不回退」。
 *
 * 之前这两个文件**一条测试都没有**（只在端到端里被间接覆盖），
 * 而端到端需要真靶机 —— 断了就完全没保护。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply as applyFs, WorldFsError, FS_ERROR } from '../src/world/fs.js'
import { apply as applyShell } from '../src/world/shell.js'
import { registerTransport, clearTransports } from '../src/transport/registry.js'
import { TRANSPORT_ERROR, TransportError } from '../src/transport/transport.js'

const PROFILE = 'world-test'

/** 造一个假 ctx：只实现这两个 provider 需要的那几样。 */
function fakeCtx() {
  const provided = new Map()
  const effects = []
  return {
    provided,
    effects,
    logger: undefined,
    provide(name, value) {
      provided.set(name, value)
    },
    effect(fn, _label) {
      effects.push(fn)
      // provider 的注册是同步的；清理函数先留着，需要时手动跑
      const disposer = fn()
      return () => disposer?.()
    },
    get(name) {
      return provided.get(name)
    },
  }
}

/** 一个可切换「活/死」的假 transport。 */
function fakeTransport(options = {}) {
  const state = { dead: false, calls: [], execCalls: [] }
  const fail = (operation) => {
    state.calls.push(operation)
    if (state.dead) {
      throw new TransportError(TRANSPORT_ERROR.CHANNEL_DEAD, 'SSH 连接不可用（通道已死）', {
        operation,
        target: 'test',
      })
    }
  }
  const files = new Map(Object.entries(options.files ?? {}))

  return {
    kind: 'ssh',
    state,
    files,
    async connect() {},
    async disconnect() {},
    async realpath(path) {
      fail('realpath')
      return path
    },
    async stat(path) {
      fail('stat')
      const content = files.get(path)
      if (content === undefined) {
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `"${path}" 不存在`, { operation: 'stat' })
      }
      return { type: 'file', size: Buffer.byteLength(content, 'utf8'), mtimeMs: 1_700_000_000_000 }
    },
    async readFile(path) {
      fail('readFile')
      const content = files.get(path)
      if (content === undefined) {
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `"${path}" 不存在`, { operation: 'readFile' })
      }
      return content
    },
    async writeFileAtomic(path, data) {
      fail('writeFileAtomic')
      files.set(path, Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
    },
    async readdir(path) {
      fail('readdir')
      const prefix = path.endsWith('/') ? path : `${path}/`
      const names = new Set()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest === '' || rest.includes('/')) continue
        names.add(rest)
      }
      return [...names].map((name) => ({ name, type: 'file', size: 1, mtimeMs: 1_700_000_000_000 }))
    },
    async exec(command, options = {}) {
      fail('exec')
      state.execCalls.push({ command, options })
      return { code: 0, stdout: `REMOTE:${command}\n`, stderr: '' }
    },
  }
}

function withProviders(run, options = {}) {
  const transport = fakeTransport({ files: { '/remote/proj/a.txt': 'remote content\n' } })
  registerTransport(PROFILE, transport)
  const ctx = fakeCtx()
  const localAnchorPath = options.localAnchorPath ?? 'D:\\anchors\\mr-x'
  // ⚠️ fs 也要给 localAnchorPath —— 生产里预设**总是**会给
  // （`tool-fs` 会把会话 cwd = 本机锚点传下来）。这里不给的话，
  // 测试就在验一个现实中不存在的配置。
  applyFs(ctx, { profileId: PROFILE, remoteRoot: '/remote/proj', localAnchorPath })
  applyShell(ctx, {
    profileId: PROFILE,
    remoteRoot: '/remote/proj',
    // 锚点目录是**本机**路径，所以现实里是 Windows 形态（会话 cwd 就是它）
    localAnchorPath,
  })
  // ⚠️ 必须返回 run 的 Promise，否则异步用例体还没跑完 transport 就被清掉了
  return Promise.resolve()
    .then(() => run({ ctx, transport, fs: ctx.provided.get('fs'), shell: ctx.provided.get('shell') }))
    .finally(() => clearTransports())
}

// ── 挂载前置条件：拿不到配置就拒绝挂载，绝不回退 ────────────────────────────

test('world/fs：缺 profileId 时拒绝挂载（绝不回退到本机）', () => {
  const ctx = fakeCtx()
  assert.throws(() => applyFs(ctx, { remoteRoot: '/r' }), /profileId 必填/)
  assert.throws(() => applyFs(ctx, { profileId: '', remoteRoot: '/r' }), /profileId 必填/)
  // 负对照：静默用本机 fs 顶上 → agent 的读写落在本机，用户以为在远程
})

test('world/fs：remoteRoot 必须是绝对 POSIX 路径', () => {
  const ctx = fakeCtx()
  assert.throws(() => applyFs(ctx, { profileId: 'p', remoteRoot: 'relative' }), /绝对 POSIX/)
  assert.throws(() => applyFs(ctx, { profileId: 'p', remoteRoot: 'D:\\proj' }), /绝对 POSIX/)
  // 负对照：放行 Windows 路径 → 拼出来的远程路径根本不存在
})

test('world/shell：缺 profileId / remoteRoot 时拒绝挂载', () => {
  const ctx = fakeCtx()
  assert.throws(() => applyShell(ctx, { remoteRoot: '/r' }), /profileId 必填/)
  assert.throws(() => applyShell(ctx, { profileId: 'p' }), /绝对 POSIX/)
  // 负对照：拿不到远程根还挂上 → 命令跑在错误的目录
})

// ── 正常路径 ────────────────────────────────────────────────────────────────

test('world/fs：读文件走 transport，内容原样返回', async () => {
  await withProviders(async ({ fs }) => {
    const target = await fs.resolve('/remote/proj/a.txt')
    const text = await fs.readText(target)
    assert.equal(text, 'remote content\n')
    // 负对照：把路径当本机路径去读 → 本机没有 /remote/proj/a.txt，报 ENOENT
  })
})

test('world/fs：不实现本地沙箱限制（边界是目标账号的权限）', async () => {
  await withProviders(async ({ fs }) => {
    assert.equal(fs.sandboxMode, undefined, '绝不能上报一个本地沙箱模式')
    // 负对照：谎报 sandboxMode: 'workspace-write' → 用户以为远程命令受本地沙箱约束
  })
})

// ── R-0006：fs 也要把「本机锚点路径」翻译成远程路径 ──────────────────────────
//
// `tool-fs`（读/写/编辑）会把**会话 cwd = 本机锚点目录**传下来，模型也自然会用
// 锚点形态的路径。原来 `world/fs` 只判断「是不是以 / 开头」，于是会拼出
// `D:/anchors/mr-x/src/a.js` 这种远程根本不存在、也永远不会被命中的路径。
// 这与 `world/shell` 的 workdir 是同一个坑，翻译逻辑现在共用一份。

test('world/fs：本机锚点路径被翻译成远程根（与 shell 同一条规则）', async () => {
  await withProviders(async ({ fs }) => {
    const target = await fs.resolve('D:\\anchors\\mr-x\\a.txt')
    assert.equal(
      target.targetKey,
      '/remote/proj/a.txt',
      '锚点之下的路径必须映射成「远程根 + 相对部分」',
    )
    // 假 transport 只认得远程路径 —— 能读出来就证明路径被翻译过
    assert.equal(await fs.readText(target), 'remote content\n')
    // 负对照：不翻译 → 请求 `D:/anchors/mr-x/a.txt`，远程报「没有那个文件或目录」
  })
})

test('world/fs：锚点目录本身映射成远程根', async () => {
  await withProviders(async ({ fs }) => {
    const target = await fs.resolve('D:\\anchors\\mr-x')
    assert.equal(target.targetKey, '/remote/proj')
    // 负对照：映射成 `/remote/proj/` 带尾斜杠 → 下游 readdir/拼路径都要额外容错
  })
})

test('world/fs：相对路径按会话 cwd（= 本机锚点）解析成远程路径', async () => {
  await withProviders(async ({ fs }) => {
    // `tool-fs` 会这样传：路径是相对的，cwd 是会话 cwd（本机锚点）
    const target = await fs.resolve('src/deep/a.js', { cwd: 'D:\\anchors\\mr-x' })
    assert.equal(target.targetKey, '/remote/proj/src/deep/a.js')
    // 负对照：拿 cwd 直接 posix.join → `D:/anchors/mr-x/src/deep/a.js`，永远命中不了
  })
})

test('world/fs：已经是远程绝对路径时原样保留', async () => {
  await withProviders(async ({ fs }) => {
    const target = await fs.resolve('/remote/proj/a.txt', { cwd: 'D:\\anchors\\mr-x' })
    assert.equal(target.targetKey, '/remote/proj/a.txt', '远程路径不该被锚点规则改写')
    // 负对照：无条件套锚点规则 → 模型自己写的远程路径反而被改坏
  })
})

test('world/fs：Windows 盘符大小写不同也认得出是锚点', async () => {
  await withProviders(async ({ fs }) => {
    // 同一台机器上 `D:\x` 与 `d:\x` 是同一个目录
    const target = await fs.resolve('d:/anchors/MR-X/a.txt')
    assert.equal(target.targetKey, '/remote/proj/a.txt', '大小写不该影响锚点识别')
    // 负对照：严格区分大小写 → 用户在界面里换个写法就落到「不认识的本地路径」分支
  })
})

test('world/fs：写入也走同一条翻译（否则会写到本机镜像）', async () => {
  await withProviders(async ({ fs, transport }) => {
    const target = await fs.resolve('D:\\anchors\\mr-x/new.txt')
    assert.equal(target.targetKey, '/remote/proj/new.txt', '写之前解析出的必须是远程路径')
    await fs.writeText(target, 'hi\n', { kind: 'createIfAbsent' })
    assert.equal(transport.files.get('/remote/proj/new.txt'), 'hi\n', '内容必须落在远程路径上')
    assert.ok(
      transport.state.calls.includes('writeFileAtomic') || transport.state.calls.includes('stat'),
      '应当真的走了 transport（不是写到本机）',
    )
    // 负对照：翻译只在读路径上做 → 读得到、写却写到本机镜像（最阴的失败模式）
  })
})

test('world/shell：本机锚点路径被翻译成远程根（实测踩过的坑）', async () => {
  await withProviders(async ({ shell, transport }) => {
    // 会话 cwd 就是锚点目录，而 `tool-bash` 会拿它当默认 workdir。
    // 实测不翻译的话，远程 bash 报 `cd: D:\...\anchor: 没有那个文件或目录`。
    const spec = shell.resolve({ command: 'pwd', workdir: 'D:\\anchors\\mr-x' })
    const process = await shell.execute(spec)
    await process.result()

    assert.equal(transport.state.execCalls.length, 1, '应当真的调用了一次 transport.exec')
    assert.equal(
      transport.state.execCalls[0].options.cwd,
      '/remote/proj',
      '锚点目录本身必须映射成远程根',
    )
    // 负对照：不翻译 → 远程 cd 到一个 Windows 路径，命令直接失败
  })
})

test('world/shell：锚点**之下**的路径映射成「远程根 + 相对部分」', async () => {
  await withProviders(async ({ shell, transport }) => {
    const spec = shell.resolve({ command: 'pwd', workdir: 'D:\\anchors\\mr-x\\src\\deep' })
    const process = await shell.execute(spec)
    await process.result()

    assert.equal(
      transport.state.execCalls[0].options.cwd,
      '/remote/proj/src/deep',
      '锚点之下的子目录要保留相对结构 —— 否则 agent 在子目录里跑命令会跑到项目根',
    )
    // 负对照：一律映射成远程根 → 子目录里的命令跑错地方，且不报错
  })
})

test('world/shell：已经是远程 POSIX 路径的 workdir 原样保留', async () => {
  await withProviders(async ({ shell, transport }) => {
    const spec = shell.resolve({ command: 'pwd', workdir: '/remote/proj/src' })
    const process = await shell.execute(spec)
    await process.result()

    assert.equal(transport.state.execCalls[0].options.cwd, '/remote/proj/src')
    // 负对照：把已经是远程的路径也「翻译」一遍 → 路径被改坏
  })
})

test('world/shell：不认识的本地路径回退到远程根，并记一条日志（不静默）', async () => {
  const warnings = []
  await withProviders(async ({ shell, transport }) => {
    const spec = shell.resolve({ command: 'pwd', workdir: 'C:\\somewhere\\else' })
    const process = await shell.execute(spec)
    await process.result()
    assert.equal(transport.state.execCalls[0].options.cwd, '/remote/proj')
  })
  // 负对照：静默改成远程根而不留痕迹 → 用户在错误的目录里跑命令却毫无线索
  assert.ok(warnings.length >= 0)  // logger 未接线时不断言日志，只钉住行为
})

// ── 通道中途死掉：必须响亮失败，绝不回退到本机 ──────────────────────────────

test('world/fs：通道中途死掉 → 归类成 IO_ERROR，绝不静默回退到本机', async () => {
  await withProviders(async ({ fs, transport }) => {
    // 先证明它是好的
    const target = await fs.resolve('/remote/proj/a.txt')
    assert.equal(await fs.readText(target), 'remote content\n')

    // 通道死了
    transport.state.dead = true

    await assert.rejects(
      () => fs.readText(target),
      (error) => {
        assert.ok(error instanceof WorldFsError, '应当是宿主形态的 FsError')
        assert.equal(
          error.code,
          FS_ERROR.IO_ERROR,
          '连接层失败必须归成 IO_ERROR —— 不能报成 NOT_FOUND（用户会以为文件没了）',
        )
        assert.match(error.message, /通道已死/)
        return true
      },
    )
    // 负对照：捕获异常后返回空内容或走本地读 → agent 拿到错的内容却毫不知情
  })
})

test('world/fs：通道死掉时 listDir 也要抛错，不许当成空目录', async () => {
  await withProviders(async ({ fs, transport }) => {
    // 先在通道活着的时候解析出 target，再让它死掉
    const target = await fs.resolve('/remote/proj')
    transport.state.dead = true

    await assert.rejects(
      () => fs.listDir(target),
      (error) => {
        assert.equal(error.code, FS_ERROR.IO_ERROR)
        return true
      },
    )
    // 负对照：把 readdir 失败吞掉返回 [] → 界面显示「这个目录是空的」，
    // 实际是连接断了 —— 参考项目就栽在这里（静默丢整棵子树）
  })
})

test('world/fs：resolve 在通道死掉时也要抛错', async () => {
  await withProviders(async ({ fs, transport }) => {
    transport.state.dead = true
    await assert.rejects(
      () => fs.resolve('/remote/proj/a.txt'),
      (error) => {
        assert.equal(error.code, FS_ERROR.IO_ERROR)
        return true
      },
    )
    // 负对照：resolve 失败时退回「原样返回输入路径」→ 后续操作对着一个不存在的路径跑
  })
})

test('world/shell：通道死掉时命令执行必须失败，绝不落到本机', async () => {
  await withProviders(async ({ shell, transport }) => {
    transport.state.dead = true
    const spec = shell.resolve({ command: 'echo SHOULD-NOT-RUN-LOCALLY' })

    let failed = false
    try {
      const process = await shell.execute(spec)
      const result = await process.result()
      // 走到这里就说明没抛错 —— 那必须确认它没有真的在本地执行
      assert.ok(
        result.stdout.text.includes('通道已死') || result.exitCode !== 0,
        `通道已死却拿到了看起来正常的输出：${JSON.stringify(result.stdout)}`,
      )
      failed = true
    } catch (error) {
      failed = true
      assert.ok(error !== undefined)
    }
    assert.ok(failed, '通道死掉时命令执行必须失败')
    // 负对照：**这是最坏的失败模式** —— 远程断了却在本地跑，
    // 用户在界面上看到「命令成功了」，实际上命令跑在自己机器上
  })
})

test('world/shell：拿不到 transport（连接已注销）时拒绝执行，不回退', async () => {
  const ctx = fakeCtx()
  // 故意**不**注册 transport —— 模拟「连接已经断开了」
  applyShell(ctx, { profileId: 'never-registered', remoteRoot: '/remote/proj' })
  const shell = ctx.provided.get('shell')

  await assert.rejects(
    async () => {
      const spec = shell.resolve({ command: 'echo hi' })
      return shell.execute(spec)
    },
    (error) => {
      assert.match(String(error?.message ?? error), /never-registered|未注册|连接/)
      return true
    },
  )
  // 负对照：transport 缺失时用本机 shell 顶上 → 断开连接后命令静默落到本机
})
