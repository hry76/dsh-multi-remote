/**
 * `src/transport/docker.js` 的契约测试。
 *
 * 不依赖真 Docker：用一个**假 Engine API 客户端**（内存容器）冒充守护进程。
 * 这样能精确控制多路复用流、退出码时序、archive 往返 —— 而这些正是最容易出错的地方。
 *
 * 真机端到端在 `transport-docker-e2e.test.mjs`（按环境变量开关）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DockerTransport, parseMultiplexed, DockerClient, parsePathStatHeader, collectFrames, parseReaddirOutput, resolveDockerEndpoints, DEFAULT_PIPE, LEGACY_PIPE } from '../src/transport/docker.js'
import { buildTar, TAR_TYPE } from '../src/transport/tar.js'
import { TRANSPORT_ERROR } from '../src/transport/transport.js'

/** 把 stdout/stderr 打包成 Docker 的多路复用流。 */
function multiplex(frames) {
  const parts = []
  for (const [streamType, text] of frames) {
    const data = Buffer.from(text, 'utf8')
    const header = Buffer.alloc(8)
    header[0] = streamType
    header.writeUInt32BE(data.length, 4)
    parts.push(header, data)
  }
  return Buffer.concat(parts)
}

/**
 * 假 Docker Engine API 客户端。
 *
 * `files` 是内存文件系统（绝对路径 → 内容），`dirs` 是目录集合。
 */
function fakeClient(options = {}) {
  // 接受 Map/Set，也接受普通对象/数组（调用方两种写法都有）
  const files = options.files instanceof Map ? options.files : new Map(Object.entries(options.files ?? {}))
  const dirs = options.dirs instanceof Set ? options.dirs : new Set(options.dirs ?? ['/', '/tmp'])
  /** 原子写的临时文件（PUT 上来但还没 mv 生效）。 */
  const tempFiles = options.tempFiles ?? new Map()
  const calls = []

  const client = {
    calls,
    files,
    dirs,
    apiPrefix: '/v1.56',
    async handshake() {
      calls.push({ op: 'handshake' })
      if (options.handshakeFails === true) {
        const { TransportError } = await import('../src/transport/transport.js')
        throw new TransportError(TRANSPORT_ERROR.CONNECT_FAILED, '连不上 Docker 守护进程', { operation: 'handshake' })
      }
      return { apiVersion: '1.56', serverVersion: '29.8.1', osType: 'linux' }
    },
    async inspectContainer(id) {
      calls.push({ op: 'inspectContainer', id })
      if (options.missingContainer === true) {
        const { TransportError } = await import('../src/transport/transport.js')
        throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, `找不到容器 "${id}"`, { operation: 'inspectContainer' })
      }
      return { State: { Running: options.running !== false }, Config: { Image: 'test:latest' } }
    },
    async createExec(containerId, spec) {
      calls.push({ op: 'createExec', spec })
      return 'exec-1'
    },
    async startExec(execId, opts) {
      calls.push({ op: 'startExec', execId })
      const spec = calls.filter((call) => call.op === 'createExec').at(-1).spec
      const result = options.onExec?.(spec) ?? { code: 0, stdout: '', stderr: '' }
      return { status: 200, headers: {}, body: multiplex([[1, result.stdout], [2, result.stderr]]) }
    },
    async inspectExec(execId) {
      calls.push({ op: 'inspectExec', execId })
      const spec = calls.filter((call) => call.op === 'createExec').at(-1).spec
      const result = options.onExec?.(spec) ?? { code: 0, stdout: '', stderr: '' }
      return { status: 200, value: { Running: false, ExitCode: result.code } }
    },
    async headArchive(containerId, path) {
      calls.push({ op: 'headArchive', path })
      if (!files.has(path) && !dirs.has(path)) return { status: 404, headers: {}, body: Buffer.alloc(0) }
      // mode 是 Go 的 os.FileMode：目录 bit31、符号链接 bit27、普通文件无类型位
      const goMode = dirs.has(path) ? 0x80000000 | 0o755 : 0o644
      const payload = {
        name: path.split('/').pop(),
        size: dirs.has(path) ? 0 : Buffer.byteLength(files.get(path) ?? '', 'utf8'),
        mode: goMode,
        mtime: '2023-11-14T22:13:20Z',
        linkTarget: '',
      }
      return {
        status: 200,
        headers: { 'x-docker-container-path-stat': Buffer.from(JSON.stringify(payload)).toString('base64') },
        body: Buffer.alloc(0),
      }
    },
    async getArchive(containerId, path) {
      calls.push({ op: 'getArchive', path })
      if (files.has(path)) {
        const name = path.split('/').pop()
        return { status: 200, headers: { 'content-type': 'application/x-tar' }, body: buildTar({ name, content: files.get(path) }) }
      }
      if (dirs.has(path)) {
        // 目录：返回该目录下所有直接子项的 tar
        const parts = []
        for (const [filePath, content] of files) {
          if (filePath.startsWith(`${path === '/' ? '' : path}/`)) {
            parts.push(buildTar({ name: filePath.slice(path === '/' ? 1 : path.length + 1), content }))
          }
        }
        return { status: 200, headers: {}, body: Buffer.concat(parts.length > 0 ? parts : [Buffer.alloc(1024)]) }
      }
      return { status: 404, headers: {}, body: Buffer.from('no such file') }
    },
    async putArchive(containerId, path, tar) {
      calls.push({ op: 'putArchive', path })
      // 解析上传的 tar，把文件放进内存文件系统。
      // 以 `.dsh-mr.` 开头的是原子写的临时文件，记进 tempFiles（等 mv 才生效）。
      const { parseTar } = await import('../src/transport/tar.js')
      for (const entry of parseTar(tar)) {
        const full = `${path === '/' ? '' : path}/${entry.name}`
        if (entry.name.startsWith('.dsh-mr.')) tempFiles.set(full, entry.data.toString('utf8'))
        else files.set(full, entry.data.toString('utf8'))
      }
      return { status: 200, headers: {}, body: Buffer.alloc(0) }
    },
    async listContainers() {
      return [{ Id: 'abc', Names: ['/test'], State: 'running' }]
    },
  }
  return client
}

/** 让假客户端的 exec 表现得像真的容器：实现我们用到的那些脚本。 */
function realishExec(files, dirs, tempFiles) {
  return (spec) => {
    const cmd = spec.Cmd
    // 原子替换：mv -f -- <temp> <target>
    if (Array.isArray(cmd) && cmd[0] === 'mv') {
      const tempPath = cmd[3]
      const target = cmd[4]
      if (tempFiles.has(tempPath)) {
        files.set(target, tempFiles.get(tempPath))
        tempFiles.delete(tempPath)
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'mv: cannot stat' }
    }
    // 清理临时文件
    if (Array.isArray(cmd) && cmd[0] === 'rm') {
      tempFiles.delete(cmd[3])
      return { code: 0, stdout: '', stderr: '' }
    }
    const script = cmd[2]
    // probe：报告容器里有哪些工具
    if (typeof script === 'string' && script.includes('command -v "$t"')) {
      return { code: 0, stdout: 'sh=1\nstat=1\nfind=1\nbase64=1\nmktemp=1\nmv=1\nreadlink=1\ndirname=1\nbash=1\n', stderr: '' }
    }
    // 探测专用：显式模拟「没有 shell」
    if (spec.Cmd[0] === 'sh' && spec.Cmd[1] === '-c' && spec.Cmd[2] === 'nope') {
      return { code: 127, stdout: '', stderr: 'sh: not found' }
    }
    // realpath
    if (typeof script === 'string' && script.includes('readlink -f')) {
      const target = cmd[4]
      if (!files.has(target) && !dirs.has(target)) return { code: 2, stdout: target, stderr: '' }
      return { code: 0, stdout: `${target}\n`, stderr: '' }
    }
    // statNul
    if (typeof script === 'string' && script.includes('stat -L --printf')) {
      const target = cmd[4]
      if (!files.has(target)) return { code: 2, stdout: '', stderr: '' }
      return {
        code: 0,
        stdout: ['regular file', String(Buffer.byteLength(files.get(target))), '1700000000', '644', '0', '0', ''].join('\0'),
        stderr: '',
      }
    }
    // readdir：可移植写法（find -exec stat ... +），NUL 分隔
    if (typeof script === 'string' && script.includes('stat -c "%n|%F|%s|%Y|%a"')) {
      const target = cmd[4]
      if (!dirs.has(target)) return { code: 2, stdout: '', stderr: '' }
      const prefix = target === '/' ? '/' : `${target}/`
      const records = []
      for (const [filePath, content] of files) {
        if (!filePath.startsWith(prefix)) continue
        const rest = filePath.slice(prefix.length)
        if (rest.includes('/')) continue
        records.push(`${filePath}|regular file|${Buffer.byteLength(content)}|1700000000|644`)
      }
      return { code: 0, stdout: records.join('\0') + (records.length > 0 ? '\0' : ''), stderr: '' }
    }
    // stageTemp：开一个临时文件并回报路径
    if (typeof script === 'string' && script.includes('DSHMR-TMP:')) {
      const target = cmd[4]
      const tempPath = `${target}.tmp-${Math.random().toString(36).slice(2, 8)}`
      tempFiles.set(tempPath, '')
      return { code: 0, stdout: `DSHMR-TMP:${tempPath}\n`, stderr: '' }
    }
    // writeTempContent：heredoc 里的 base64 解码后写进临时文件
    if (typeof script === 'string' && script.includes('base64 -d >')) {
      const match = /tmp='([^']+)'/.exec(script)
      const tempPath = match?.[1]
      const payload = /\n([A-Za-z0-9+/=]+)\nDSHMR/.exec(script)?.[1] ?? ''
      if (tempPath !== undefined) {
        tempFiles.set(tempPath, Buffer.from(payload, 'base64').toString('utf8'))
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    // commitTemp：把临时文件原子搬到目标
    if (typeof script === 'string' && script.includes('mv -f --')) {
      const tempPath = cmd[4]
      const target = cmd[5]
      if (tempFiles.has(tempPath)) {
        files.set(target, tempFiles.get(tempPath))
        tempFiles.delete(tempPath)
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 5, stdout: '', stderr: 'mv failed' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

async function withTransport(options, fn) {
  const files = new Map(Object.entries(options.files ?? {}))
  const dirs = new Set(options.dirs ?? ['/', '/tmp', '/data'])
  /** 临时文件表（stageTemp → writeTempContent → commitTemp 三步用）。 */
  const tempFiles = new Map()
  const client = fakeClient({ ...options, files, dirs, tempFiles })
  const transport = new DockerTransport({ container: options.container ?? 'test', client })
  /**
   * 每个 exec 的结果只算一次。
   * 真实容器里 exec 也是「跑一次」——start 拿输出、inspect 拿退出码，是**同一个**执行。
   * 如果两边各算一次，有状态的脚本（stage → write → commit）会被执行两遍。
   */
  const execResults = new Map()
  const runOnce = function () {
    const spec = this.calls.filter((call) => call.op === 'createExec').at(-1).spec
    const key = JSON.stringify(spec)
    if (!execResults.has(key)) execResults.set(key, realishExec(files, dirs, tempFiles)(spec))
    return execResults.get(key)
  }
  client.startExec = async function () {
    const result = runOnce.call(this)
    return { status: 200, headers: {}, body: multiplex([[1, result.stdout], [2, result.stderr]]) }
  }
  client.inspectExec = async function () {
    const result = runOnce.call(this)
    return { status: 200, value: { Running: false, ExitCode: result.code } }
  }
  return fn({ transport, client, files, dirs, tempFiles })
}

// ── 多路复用流解析 ──────────────────────────────────────────────────────────

test('parseMultiplexed：正确拆出 stdout(1) 与 stderr(2)', () => {
  const stream = multiplex([[1, 'OUT'], [2, 'ERR']])
  const frames = parseMultiplexed(stream)
  assert.deepEqual(frames.map((f) => f.streamType), [1, 2])
  assert.equal(frames[0].data.toString('utf8'), 'OUT')
  assert.equal(frames[1].data.toString('utf8'), 'ERR')
  // 负对照：不解析头、直接当纯文本 → 输出里会混进 8 字节二进制垃圾
})

test('parseMultiplexed：多帧同流要拼接', () => {
  const stream = multiplex([[1, 'line1\n'], [1, 'line2\n'], [2, 'err\n']])
  const frames = parseMultiplexed(stream)
  assert.equal(frames.filter((f) => f.streamType === 1).map((f) => f.data.toString('utf8')).join(''), 'line1\nline2\n')
  // 负对照：只取第一帧 → 长输出会被截断
})

test('parseMultiplexed：流被截断时不丢数据', () => {
  const full = multiplex([[1, 'abcdef']])
  const truncated = full.subarray(0, full.length - 2)
  const frames = parseMultiplexed(truncated)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].data.toString('utf8'), 'abcd')
  // 负对照：越界就读 → 抛 RangeError 或读到脏数据
})

// ── 连接 ────────────────────────────────────────────────────────────────────

test('connect：容器没在运行也能连上，但 exec/readdir 明确报错并说明原因', async () => {
  await withTransport({ running: false }, async ({ transport }) => {
    // 实测：archive 端点在停止的容器上照样可用，所以不再一刀切拒绝连接
    await transport.connect()
    assert.equal(transport.connected, true)
    assert.equal(transport.containerRunning, false)
    assert.equal(transport.shell, undefined, '没在运行时不该声称有 shell')

    // 但需要 exec 的操作要明确报错，且**说清是「没在运行」而不是「没 shell」**
    await assert.rejects(
      () => transport.exec('echo x'),
      (error) => {
        assert.match(error.message, /没有在运行/)
        assert.match(error.message, /文件\*\*内容\*\*的读写仍然可用|archive/)
        assert.match(error.message, /不会替你启动/)
        return true
      },
    )
    await assert.rejects(
      () => transport.readdir('/data'),
      (error) => {
        assert.match(error.message, /没有在运行/)
        return true
      },
    )
    // 负对照：连接时就拒绝 → 用户没法用「只读文件内容」这个真实可用的能力
  })
})

test('connect：容器在跑但没 shell 时，报错要指向「没有 shell」而不是「没在运行」', async () => {
  await withTransport({ files: {} }, async ({ transport, client }) => {
    client.createExec = async () => {
      const { TransportError } = await import('../src/transport/transport.js')
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, 'exec 失败', { operation: 'createExec' })
    }
    await transport.connect()
    assert.equal(transport.containerRunning, true)
    assert.equal(transport.capabilities.shell, false)

    await assert.rejects(
      () => transport.exec('echo x'),
      (error) => {
        assert.match(error.message, /没有可用的 shell/)
        assert.doesNotMatch(error.message, /没有在运行/, '别把「没 shell」说成「没运行」——修法完全不同')
        return true
      },
    )
    // 负对照：两种失败混成一句话 → 用户不知道该去 docker start 还是换镜像
  })
})

test('readFile：容器没在运行时仍可用（archive 不依赖 exec）', async () => {
  await withTransport({ running: false, files: { '/data/readme.txt': 'hello\n' } }, async ({ transport, client }) => {
    await transport.connect()
    // archive 端点不需要 exec，所以读文件内容应当照常工作
    const text = await transport.readFile('/data/readme.txt', { encoding: 'utf8' })
    assert.equal(text, 'hello\n')
    assert.equal(client.calls.filter((call) => call.op === 'createExec').length, 0, '不该发起任何 exec')
    // 负对照：把「容器在跑」当成读文件的前提 → 白白丢掉一个实测可用的能力
  })
})

test('connect：容器不存在时报 NOT_FOUND', async () => {
  await withTransport({ missingContainer: true }, async ({ transport }) => {
    await assert.rejects(
      () => transport.connect(),
      (error) => error.code === TRANSPORT_ERROR.NOT_FOUND,
    )
    // 负对照：把 404 当普通错误 → 用户看到一堆看不懂的失败
  })
})

test('connect：成功时记录 API 版本与能力，且幂等', async () => {
  await withTransport({ files: { '/data/a.txt': 'x' } }, async ({ transport }) => {
    await transport.connect()
    assert.equal(transport.apiVersion, '1.56')
    assert.equal(transport.capabilities.bash, true)
    assert.equal(transport.shell, 'bash', '容器有 bash 时优先用它（拿到登录环境）')
    await transport.connect()  // 幂等
    assert.equal(transport.connected, true)
    // 负对照：不探测能力 → alpine（没有 bash）上每个 exec 都失败
  })
})

test('connect：容器里没有 bash 时退化到 sh', async () => {
  await withTransport({ files: {} }, async ({ transport, client }) => {
    client.startExec = async () => ({ status: 200, headers: {}, body: multiplex([[1, 'sh=1\nbash=0\n']]) })
    client.inspectExec = async () => ({ status: 200, value: { Running: false, ExitCode: 0 } })
    await transport.connect()
    assert.equal(transport.capabilities.bash, false)
    assert.equal(transport.shell, 'sh', '没有 bash 时退化到 sh（alpine 就是这种）')
    // 负对照：硬编码 bash → alpine 容器上直接 127
  })
})

test('connect：容器里连 sh 都没有时，连接仍成功但 exec 明确报错', async () => {
  await withTransport({ files: {} }, async ({ transport, client }) => {
    client.startExec = async () => ({ status: 200, headers: {}, body: multiplex([[2, 'exec: "sh": not found']]) })
    client.inspectExec = async () => ({ status: 200, value: { Running: false, ExitCode: 127 } })
    // 让能力探测失败（连 sh 都起不来）
    client.createExec = async () => {
      const { TransportError } = await import('../src/transport/transport.js')
      throw new TransportError(TRANSPORT_ERROR.UNKNOWN, 'exec 失败', { operation: 'createExec' })
    }
    await transport.connect()
    assert.equal(transport.capabilities.shell, false)

    await assert.rejects(
      () => transport.exec('echo x'),
      (error) => {
        assert.match(error.message, /没有可用的 shell/)
        assert.match(error.message, /archive/, '要说明文件内容读写仍可用')
        return true
      },
    )
    // 负对照：静默继续 → 后续命令执行给出一堆莫名失败（distroless 镜像就是这种）
  })
})

// ── 文件操作 ────────────────────────────────────────────────────────────────

test('readFile：走 archive 端点，不依赖容器里的工具', async () => {
  await withTransport({ files: { '/data/hello.txt': 'hello archive\n' } }, async ({ transport, client }) => {
    await transport.connect()
    const text = await transport.readFile('/data/hello.txt', { encoding: 'utf8' })
    assert.equal(text, 'hello archive\n')

    const archiveCalls = client.calls.filter((call) => call.op === 'getArchive')
    assert.equal(archiveCalls.length, 1, '读文件应当走 archive 端点')
    // 负对照：走 exec + base64 → distroless 容器里没有 base64，直接不可用
  })
})

test('readFile：超过 maxBytes 必须失败，绝不截断', async () => {
  await withTransport({ files: { '/data/big.txt': 'x'.repeat(5000) } }, async ({ transport }) => {
    await transport.connect()
    await assert.rejects(
      () => transport.readFile('/data/big.txt', { maxBytes: 100 }),
      (error) => error.code === TRANSPORT_ERROR.TOO_LARGE,
    )
    // 负对照：截断 → 上层以为拿到的是完整内容
  })
})

test('readFile：NUL 字节报 NOT_TEXT', async () => {
  await withTransport({ files: { '/data/bin': 'a\0b' } }, async ({ transport }) => {
    await transport.connect()
    await assert.rejects(
      () => transport.readFile('/data/bin', { encoding: 'utf8' }),
      (error) => error.code === TRANSPORT_ERROR.NOT_TEXT,
    )
    // 负对照：放行 → 上层拿到带 \0 的「文本」
  })
})

test('readFile：不存在报 NOT_FOUND', async () => {
  await withTransport({ files: {} }, async ({ transport }) => {
    await transport.connect()
    await assert.rejects(
      () => transport.readFile('/data/nope.txt'),
      (error) => error.code === TRANSPORT_ERROR.NOT_FOUND,
    )
    // 负对照：404 当普通错误 → 上层无法区分「不存在」与「读取失败」
  })
})

test('readFile：目录报 WRONG_TYPE', async () => {
  await withTransport({ files: {}, dirs: ['/', '/tmp', '/data'] }, async ({ transport, client }) => {
    await transport.connect()
    // 让 archive 对目录返回一个目录条目
    client.getArchive = async () => ({
      status: 200,
      headers: {},
      body: buildTar({ name: 'data/', type: '5' }),
    })
    await assert.rejects(
      () => transport.readFile('/data'),
      (error) => error.code === TRANSPORT_ERROR.WRONG_TYPE,
    )
    // 负对照：把目录当文件读 → 返回空内容，上层以为文件是空的
  })
})

test('stat：解析 NUL 分隔字段', async () => {
  await withTransport({ files: { '/data/f.txt': 'content' } }, async ({ transport }) => {
    await transport.connect()
    const info = await transport.stat('/data/f.txt')
    assert.equal(info.type, 'file')
    assert.equal(info.size, 7)
    assert.equal(info.mtimeMs, 1_700_000_000_000)
    // 负对照：用空格分隔 → 文件名含空格时字段错位
  })
})

test('readdir：一次 exec 拿全', async () => {
  await withTransport({ files: { '/data/a.txt': 'a', '/data/b.txt': 'bb' } }, async ({ transport, client }) => {
    await transport.connect()
    const before = client.calls.filter((call) => call.op === 'createExec').length
    const entries = await transport.readdir('/data')
    const after = client.calls.filter((call) => call.op === 'createExec').length

    assert.deepEqual(entries.map((entry) => entry.name).sort(), ['a.txt', 'b.txt'])
    assert.equal(after - before, 1, 'readdir 必须只花一次 exec')
    // 负对照：逐文件 stat → N 个文件 = N 次 exec，2000 文件慢到不可用
  })
})

test('writeFileAtomic：内容走 archive 上传（不进 argv），然后容器内原子 rename', async () => {
  await withTransport({ files: { '/data/out.txt': 'old' } }, async ({ transport, client }) => {
    await transport.connect()
    await transport.writeFileAtomic('/data/out.txt', 'new content\n')

    // 1) 内容经 archive 上传 —— 是请求体，不受 argv 限制
    const puts = client.calls.filter((call) => call.op === 'putArchive')
    assert.equal(puts.length, 1, '应当有一次 archive 上传')

    // 2) 容器内 mv -f 原子替换
    const moves = client.calls.filter(
      (call) => call.op === 'createExec' && Array.isArray(call.spec.Cmd) && call.spec.Cmd[0] === 'mv',
    )
    assert.equal(moves.length, 1, '应当有一次 mv')
    assert.equal(moves[0].spec.Cmd[1], '-f')

    // 3) 临时文件必须与目标**同目录**：rename(2) 只在同一文件系统内原子，
    //    放 /tmp 可能跨挂载点，`mv` 会退化成「复制 + 删除」
    const tempPath = moves[0].spec.Cmd[3]
    assert.match(tempPath, /^\/data\/\.dsh-mr\./, `临时文件应当与目标同目录：${tempPath}`)
    assert.equal(moves[0].spec.Cmd[4], '/data/out.txt')
    // 负对照：直接 PUT 到最终路径 → 没有原子替换语义，中途失败会写坏原文件
  })
})

test('writeFileAtomic：内容绝不进 argv（内核单参数上限 128 KiB）', async () => {
  // 实测：Linux 的 MAX_ARG_STRLEN = 131072 字节/参数，与 ARG_MAX（2 MiB）无关。
  // 超了内核直接 E2BIG，容器里看到 `exec /usr/bin/sh: argument list too long`。
  // 所以任何「把内容拼进命令行」的写法都有硬上限 —— 必须走请求体。
  const big = 'x'.repeat(300_000)
  await withTransport({ files: {} }, async ({ transport, client }) => {
    await transport.connect()
    await transport.writeFileAtomic('/data/big.txt', big)

    const longestArg = client.calls
      .filter((call) => call.op === 'createExec')
      .flatMap((call) => call.spec.Cmd)
      .filter((part) => typeof part === 'string')
      .reduce((max, part) => Math.max(max, Buffer.byteLength(part, 'utf8')), 0)

    assert.ok(
      longestArg < 131_072,
      `最长的 argv 参数是 ${longestArg} 字节 —— 超过内核 128 KiB 上限就会被 E2BIG 拒绝`,
    )
    // 负对照：把内容放进脚本或参数 → 300 KB 的内容必然超限
  })
})

test('exec：命令经 shell，且返回退出码与两路输出', async () => {
  await withTransport({ files: {} }, async ({ transport, client }) => {
    await transport.connect()
    client.startExec = async () => ({ status: 200, headers: {}, body: multiplex([[1, 'OUT'], [2, 'ERR']]) })
    client.inspectExec = async () => ({ status: 200, value: { Running: false, ExitCode: 7 } })

    const result = await transport.exec('echo hi')
    assert.equal(result.code, 7)
    assert.equal(result.stdout, 'OUT')
    assert.equal(result.stderr, 'ERR')

    const spec = client.calls.filter((call) => call.op === 'createExec').at(-1).spec
    assert.equal(spec.Cmd[0], 'bash', '有 bash 时应当用 bash')
    assert.equal(spec.Cmd[1], '-lc', '应当走登录 shell（拿到用户 PATH）')
    // 负对照：用 sh -c → 没有登录环境，PATH 可能缺东西
  })
})

test('exec：cwd 与 env 传给 WorkingDir / Env', async () => {
  await withTransport({ files: {} }, async ({ transport, client }) => {
    await transport.connect()
    client.startExec = async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) })
    client.inspectExec = async () => ({ status: 200, value: { Running: false, ExitCode: 0 } })

    await transport.exec('pwd', { cwd: '/data', env: { FOO: 'bar' } })
    const spec = client.calls.filter((call) => call.op === 'createExec').at(-1).spec
    assert.equal(spec.WorkingDir, '/data')
    assert.deepEqual(spec.Env, ['FOO=bar'])
    // 负对照：不传 WorkingDir → 命令跑在容器默认目录，不是项目根
  })
})

test('exec：命令含 NUL 直接拒绝', async () => {
  await withTransport({ files: {} }, async ({ transport }) => {
    await transport.connect()
    await assert.rejects(() => transport.exec('echo \0hi'), /NUL/)
    // 负对照：放行 → 守护进程报 invalid format，错误指不到原因
  })
})

test('exec：退出码一直没落定时如实报 TIMEOUT，不假装成功', async () => {
  await withTransport({ files: {} }, async ({ transport, client }) => {
    await transport.connect()
    client.startExec = async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) })
    client.inspectExec = async () => ({ status: 200, value: { Running: true, ExitCode: null } })
    await assert.rejects(
      () => transport.exec('sleep 1'),
      (error) => error.code === TRANSPORT_ERROR.TIMEOUT,
    )
    // 负对照：默认成 0 → 上层以为命令成功了
  })
})

test('parsePathStatHeader：mode 是 Go 的 FileMode，不是 POSIX st_mode', () => {
  const encode = (payload) => Buffer.from(JSON.stringify(payload)).toString('base64')

  // 目录：bit31
  const dir = parsePathStatHeader(encode({ name: 'd', size: 4096, mode: 0x80000000 | 0o755, mtime: '2023-11-14T22:13:20Z' }))
  assert.equal(dir.type, 'directory', 'bit31 必须识别成目录')
  assert.equal(dir.mode, 0o755, '只保留权限位')

  // 符号链接：bit27
  const link = parsePathStatHeader(encode({ name: 'l', size: 0, mode: 0x08000000 | 0o777, mtime: '2023-11-14T22:13:20Z' }))
  assert.equal(link.type, 'symlink')

  // 普通文件：没有类型位
  const file = parsePathStatHeader(encode({ name: 'f', size: 12, mode: 0o644, mtime: '2023-11-14T22:13:20Z' }))
  assert.equal(file.type, 'file')
  assert.equal(file.size, 12)
  assert.ok(file.mtimeMs > 1_600_000_000_000)

  // 畸形输入不抛错
  assert.equal(parsePathStatHeader(undefined), undefined)
  assert.equal(parsePathStatHeader(''), undefined)
  assert.equal(parsePathStatHeader('!!!not-base64!!!'), undefined)
  // 负对照：把 mode 当 st_mode（低 16 位里的 0o40000 才是目录）→ 目录会被认成普通文件
})

test('collectFrames：streamType 3 是守护进程错误，不能当输出', () => {
  const frames = [
    { streamType: 1, data: Buffer.from('out') },
    { streamType: 2, data: Buffer.from('err') },
    { streamType: 3, data: Buffer.from('daemon blew up') },
  ]
  const collected = collectFrames(frames)
  assert.equal(collected.stdout, 'out')
  assert.equal(collected.stderr, 'err')
  assert.equal(collected.systemerr, 'daemon blew up')
  assert.ok(!collected.stdout.includes('daemon'), '守护进程错误绝不能混进 stdout')
  // 负对照：只认 1/2 → 守护进程的错误被静默丢掉，用户看到「成功但没有输出」
})

test('readFile：符号链接要解析后重取（archive 返回的是链接本身）', async () => {
  // 实测：archive 端点对符号链接返回的是**链接条目**（数据为空），不跟随目标。
  // 不处理的话，agent 读一个符号链接会拿到空字符串 —— 看起来像「文件是空的」。
  await withTransport({
    files: { '/data/real.txt': 'target content\n' },
    dirs: ['/', '/tmp', '/data'],
  }, async ({ transport, client }) => {
    await transport.connect()

    // 让 archive 对 link.txt 返回一个符号链接条目
    const original = client.getArchive.bind(client)
    client.getArchive = async (containerId, path) => {
      if (path === '/data/link.txt') {
        return {
          status: 200,
          headers: {},
          body: buildTar({ name: 'link.txt', type: '2', linkTarget: 'real.txt' }),
        }
      }
      return original(containerId, path)
    }
    // realpath 把链接解析到真实路径
    client.startExec = async function () {
      const spec = this.calls.filter((call) => call.op === 'createExec').at(-1).spec
      if (typeof spec.Cmd[2] === 'string' && spec.Cmd[2].includes('readlink -f')) {
        return { status: 200, headers: {}, body: multiplex([[1, '/data/real.txt\n']]) }
      }
      return { status: 200, headers: {}, body: Buffer.alloc(0) }
    }
    client.inspectExec = async () => ({ status: 200, value: { Running: false, ExitCode: 0 } })

    const text = await transport.readFile('/data/link.txt', { encoding: 'utf8' })
    assert.equal(text, 'target content\n', '应当跟随符号链接读到目标内容')
    // 负对照：不处理符号链接 → 返回空字符串，上层以为文件是空的
  })
})

test('readFile：目录判定要与 tar 的 typeflag 对上', async () => {
  // 实测抓到的 bug：TAR_TYPE.DIRECTORY 是字符串 '5'，
  // 而一开始写的比较用的是数字 5 → 目录被当成普通文件读，返回空内容。
  assert.equal(TAR_TYPE.DIRECTORY, '5')
  assert.equal(typeof TAR_TYPE.DIRECTORY, 'string')
  // 负对照：把 TAR_TYPE.DIRECTORY 改成数字 5 → 下面的目录用例会失败
})

test('parseReaddirOutput：解析 NUL 分隔的 stat 记录（busybox 与 coreutils 通用）', () => {
  // busybox 与 coreutils 的 stat -c %F 都给同样的英文描述（实测）
  const stdout = [
    '/data/a.txt|regular file|11|1700000000|644',
    '/data/sub|directory|4096|1700000001|755',
    '/data/link|symbolic link|0|1700000002|777',
  ].join('\0') + '\0'

  const entries = parseReaddirOutput(stdout, '/data')
  assert.deepEqual(entries.map((entry) => entry.name), ['a.txt', 'sub', 'link'])
  assert.equal(entries[0].type, 'file')
  assert.equal(entries[0].size, 11)
  assert.equal(entries[0].mtimeMs, 1_700_000_000_000)
  assert.equal(entries[1].type, 'directory')
  assert.equal(entries[2].type, 'symlink')
  // 负对照：用 find -printf → busybox 的 find 没有这个选项，alpine 上直接失败
})

test('parseReaddirOutput：文件名含空格也解析正确', () => {
  const stdout = '/data/has space.txt|regular file|3|1700000000|644\0'
  const entries = parseReaddirOutput(stdout, '/data')
  assert.equal(entries[0].name, 'has space.txt')
  // 负对照：用空格分隔字段 → 名字被切成两半
})

test('parseReaddirOutput：嵌套项要被过滤掉（只要直接子项）', () => {
  const stdout = [
    '/data/a.txt|regular file|1|1700000000|644',
    '/data/deep/nested.txt|regular file|1|1700000000|644',
  ].join('\0') + '\0'
  const entries = parseReaddirOutput(stdout, '/data')
  assert.deepEqual(entries.map((entry) => entry.name), ['a.txt'])
  // 负对照：不过滤 → 树形遍历会把深层文件当成本层文件，格局层会重复
})

test('parseReaddirOutput：尾斜杠的目录路径也能正确处理', () => {
  const stdout = '/data/a.txt|regular file|1|1700000000|644\0'
  assert.deepEqual(parseReaddirOutput(stdout, '/data/').map((entry) => entry.name), ['a.txt'])
  // 负对照：不归一化尾斜杠 → 前缀拼成 '/data//'，一条都匹配不上
})

test('parseReaddirOutput：畸形记录被跳过而不是崩', () => {
  const stdout = 'garbage\0/data/a.txt|regular file|1|1700000000|644\0'
  const entries = parseReaddirOutput(stdout, '/data')
  assert.deepEqual(entries.map((entry) => entry.name), ['a.txt'])
  // 负对照：直接按索引取值 → 畸形记录让整次遍历抛错
})

test('构造：缺少 container 直接抛错', () => {
  assert.throws(() => new DockerTransport({}), /container/)
  assert.throws(() => new DockerTransport({ container: '  ' }), /container/)
  // 负对照：允许空 container → 每个操作都失败在深处
})

// ── 引擎重启后的自动重连 ────────────────────────────────────────────────────

/** 一个能模拟「守护进程重启」的假客户端。 */
function restartableClient() {
  const state = { generation: 0, handshakes: 0, invalidated: 0, pendingFailure: undefined }
  const client = {
    state,
    endpoints: ['\\\\.\\pipe\\fake'],
    apiPrefix: '/v1.56',
    invalidateHandshake() {
      client.apiPrefix = ''
      state.invalidated += 1
    },
    async handshake() {
      state.handshakes += 1
      client.apiPrefix = `/v1.${56 + state.generation}`
      return { apiVersion: `1.${56 + state.generation}`, serverVersion: 'test', osType: 'linux', pipe: 'fake' }
    },
    async inspectContainer() {
      return { State: { Running: true }, Config: { Image: 'test:latest' } }
    },
    async createExec(containerId, spec) {
      // 引擎重启过之后，第一次调用会失败（旧管道已死）
      if (state.pendingFailure !== undefined) {
        const failure = state.pendingFailure
        state.pendingFailure = undefined
        const { TransportError } = await import('../src/transport/transport.js')
        throw new TransportError(failure.code, failure.message, { operation: 'createExec', retryable: true })
      }
      return 'exec-1'
    },
    async startExec() {
      // 让能力探测能通过（否则 connect 会判定「没有 shell」，后面的 exec 直接被拦住）
      return { status: 200, headers: {}, body: multiplex([[1, 'sh=1\nbash=1\n']]) }
    },
    async inspectExec() {
      return { status: 200, value: { Running: false, ExitCode: 0 } }
    },
  }
  return client
}

test('重连：引擎重启导致管道失效时，自动重连一次并成功', async () => {
  // 实测场景（2026-10-07）：Docker Desktop 自动更新会让引擎重启，
  // 旧命名管道失效，此后每个操作都失败 —— 但重连一下就好。
  const client = restartableClient()
  const transport = new DockerTransport({ container: 'test', client })
  await transport.connect()
  assert.equal(client.state.handshakes, 1)

  const { TransportError } = await import('../src/transport/transport.js')
  client.state.pendingFailure = {
    code: TRANSPORT_ERROR.CHANNEL_DEAD,
    message: '与 Docker 守护进程的连接断了（EPIPE）',
  }
  client.state.generation = 1

  const result = await transport.exec('echo hi')
  assert.equal(result.code, 0, '重连之后应当成功')
  assert.equal(transport.reconnects, 1, '应当重连过一次')
  assert.equal(client.state.handshakes, 2, '应当重新握手')
  assert.equal(client.state.invalidated, 1, '应当让旧握手结果失效')
  // 负对照：不重连 → 用户看到「连接断了」，完全想不到「重连一下就好」
})

test('重连：只重试一次，不会无限循环', async () => {
  const client = restartableClient()
  const transport = new DockerTransport({ container: 'test', client })
  await transport.connect()

  const { TransportError } = await import('../src/transport/transport.js')
  // 让**真正的 exec** 一直失败，但重连时的能力探测要能过 ——
  // 按脚本体识别探测（探测脚本里有 `command -v`），不能按参数位置猜
  const originalCreateExec = client.createExec
  client.createExec = async (containerId, spec) => {
    const script = spec?.Cmd?.[2]
    const isProbe = typeof script === 'string' && script.includes('command -v')
    if (isProbe) return originalCreateExec(containerId, spec)
    throw new TransportError(TRANSPORT_ERROR.CHANNEL_DEAD, '一直是死的', { operation: 'createExec' })
  }

  await assert.rejects(() => transport.exec('echo hi'), (error) => error.code === TRANSPORT_ERROR.CHANNEL_DEAD)
  assert.equal(transport.reconnects, 1, '只重连一次就放弃')
  // 负对照：无限重试 → 守护进程真的没起来时，一次失败被拖成长时间卡顿
})

test('重连：**不**对「操作的正常结果」重试（NOT_FOUND 等）', async () => {
  const client = restartableClient()
  const transport = new DockerTransport({ container: 'test', client })
  await transport.connect()
  const handshakesAfterConnect = client.state.handshakes

  const { TransportError } = await import('../src/transport/transport.js')
  client.createExec = async () => {
    throw new TransportError(TRANSPORT_ERROR.NOT_FOUND, '文件不存在', { operation: 'createExec' })
  }

  await assert.rejects(() => transport.exec('ls'), (error) => error.code === TRANSPORT_ERROR.NOT_FOUND)
  assert.equal(transport.reconnects, 0, 'NOT_FOUND 不是连接问题，不该重连')
  assert.equal(client.state.handshakes, handshakesAfterConnect, '不该重新握手')
  // 负对照：什么都重试 → 同一个错误慢一倍才出现，而且掩盖真正的问题
})

test('重连：重连本身失败时，报**重连失败**的原因（比原始错误更有指导性）', async () => {
  const client = restartableClient()
  const transport = new DockerTransport({ container: 'test', client })
  await transport.connect()

  const { TransportError } = await import('../src/transport/transport.js')
  client.state.pendingFailure = { code: TRANSPORT_ERROR.CHANNEL_DEAD, message: '管道死了' }
  client.handshake = async () => {
    throw new TransportError(TRANSPORT_ERROR.CONNECT_FAILED, '连不上 Docker 守护进程。确认 Docker Desktop 已启动。', {
      operation: 'handshake',
    })
  }

  await assert.rejects(
    () => transport.exec('echo hi'),
    (error) => {
      assert.equal(error.code, TRANSPORT_ERROR.CONNECT_FAILED)
      assert.match(error.message, /Docker Desktop/)
      return true
    },
  )
  // 负对照：报原始错误（「管道死了」）→ 用户不知道该去启动 Docker Desktop
})

test('DockerClient：连不上守护进程归类成 CONNECT_FAILED，且标记可重试', async () => {
  const client = new DockerClient({ pipe: '\\\\.\\pipe\\definitely-not-real-for-reconnect-test' })
  await assert.rejects(
    () => client.request('/version', { timeoutMs: 2000 }),
    (error) => {
      assert.equal(error.code, TRANSPORT_ERROR.CONNECT_FAILED)
      assert.equal(error.retryable, true, '连不上值得重试')
      return true
    },
  )
  // 负对照：连不上报成 UNKNOWN → 上层不知道能不能重试
})

test('DockerClient.invalidateHandshake：清掉缓存的 API 前缀', () => {
  const client = new DockerClient({ pipe: '\\\\.\\pipe\\x' })
  client.apiPrefix = '/v1.56'
  client.invalidateHandshake()
  assert.equal(client.apiPrefix, '', '应当被清空 —— 旧管道上拿到的前缀不再可信')
  // 负对照：不清 → 重连时还用旧前缀去连一个已经没了的管道
})

// ── 守护进程错误：说得清，而不是 [object Object] ────────────────────────────

test('daemonError：409 = 容器没在运行，报得清楚且提示 docker start', () => {
  // 实测：引擎重启后容器会被停掉，此时 create exec 回 409
  // `{"message":"container <id> is not running"}`。
  // 修之前报的是 `创建 exec 失败（HTTP 409）：[object Object]` —— 等于什么都没说。
  const error = DockerClient.daemonError(409, { message: 'container abc is not running' }, 'createExec', 'abc')
  assert.equal(error.code, TRANSPORT_ERROR.CONNECT_FAILED)
  assert.equal(error.retryable, true)
  assert.match(error.message, /is not running/, '必须带上守护进程的原话')
  assert.match(error.message, /docker start/, '必须告诉用户该做什么')
  assert.ok(!error.message.includes('[object Object]'), '绝不能出现 [object Object]')
  // 负对照：`String(value)` → [object Object]，用户完全不知道发生了什么
})

test('daemonError：404 = 容器不存在，归成 NOT_FOUND 且不可重试', () => {
  const error = DockerClient.daemonError(404, { message: 'No such container: nope' }, 'createExec', 'nope')
  assert.equal(error.code, TRANSPORT_ERROR.NOT_FOUND)
  assert.equal(error.retryable, false, '容器不存在，重试没有意义')
  assert.match(error.message, /No such container/)
  // 负对照：404 也当 UNKNOWN → 上层无法区分「不存在」与「连不上」
})

test('daemonError：原始字符串/ Buffer 也能解析出 message', () => {
  const fromString = DockerClient.daemonError(409, '{"message":"from string"}', 'x', 'y')
  assert.equal(fromString.message.includes('from string'), true)

  const fromBuffer = DockerClient.daemonError(404, Buffer.from('{"message":"from buffer"}', 'utf8'), 'x', 'y')
  assert.equal(fromBuffer.message.includes('from buffer'), true)

  // 不是 JSON 时退回原文（截断），不抛错
  const plain = DockerClient.daemonError(500, 'not json at all', 'x', 'y')
  assert.equal(plain.code, TRANSPORT_ERROR.UNKNOWN)
  assert.match(plain.message, /not json at all/)
  // 负对照：JSON.parse 失败直接抛 → 报错时再抛一个错，掩盖真问题
})

test('daemonError：其它状态码归 UNKNOWN，但 message 仍可读', () => {
  const error = DockerClient.daemonError(500, { message: 'internal server error' }, 'x', 'y')
  assert.equal(error.code, TRANSPORT_ERROR.UNKNOWN)
  assert.equal(error.message, 'internal server error')
  assert.ok(!error.message.includes('[object Object]'))
  // 负对照：所有状态码都归一类 → 用户分不清是「容器没了」还是「守护进程坏了」
})

test('startExecTty：必须带 Upgrade 头（真机走的是 upgrade 分支）', async () => {
  // 实测（Engine 29.8.1 / API 1.56）：守护进程**按 Upgrade 头分支**
  //   带 Connection: Upgrade + Upgrade: tcp → 101 UPGRADED → Node 'upgrade'
  //   不带                                    → 200 OK      → Node 'response'
  // 我们的实现带头，所以真机走 'upgrade'。这条钉住那个头 —— 去掉它虽然仍能工作
  // （会落到 'response' 分支），但就偏离了实测确认的那条路。
  const { createServer } = await import('node:net')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = await mkdtemp(join(tmpdir(), 'tty-upgrade-'))
  const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-tty-${Date.now()}` : join(dir, 'sock')
  const seen = []
  const server = createServer((socket) => {
    socket.once('data', (chunk) => {
      const head = chunk.toString('latin1')
      seen.push(head)
      // 回一个 101，让客户端走 'upgrade' 分支
      socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n')
    })
  })
  await new Promise((resolve) => server.listen(pipePath, resolve))

  try {
    const client = new DockerClient({ pipe: pipePath })
    client.apiPrefix = '/v1.56'
    const socket = await client.startExecTty('exec-1', {})
    socket.destroy()

    assert.equal(seen.length, 1, '服务端应当收到请求')
    assert.match(seen[0], /POST \/v1\.56\/exec\/exec-1\/start HTTP\/1\.1/)
    assert.match(seen[0], /Connection: Upgrade/i, '必须带 Connection: Upgrade')
    assert.match(seen[0], /Upgrade: tcp/i, '必须带 Upgrade: tcp')
    assert.match(seen[0], /"Tty":true/, 'TTY exec 必须声明 Tty: true')
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  // 负对照：去掉 Upgrade 头 → 落到 'response' 分支；真机上仍能用，但偏离实测路径
})

test('testConnection：容器未运行时返回结构化失败而不是抛错', async () => {
  await withTransport({ running: false }, async ({ transport }) => {
    const result = await transport.testConnection()
    assert.equal(result.ok, false)
    assert.equal(result.code, TRANSPORT_ERROR.CONNECT_FAILED)
    assert.match(result.detail, /未在运行/)
    // 负对照：抛错 → 工具层要额外包 try/catch
  })
})

test('DockerClient：管道不可用时给出可执行的提示（且两个管道都试过）', async () => {
  const client = new DockerClient({ pipe: '\\\\.\\pipe\\definitely-not-a-real-pipe' })
  await assert.rejects(
    () => client.handshake({ timeoutMs: 2000, pipe: '\\\\.\\pipe\\definitely-not-a-real-pipe' }),
    (error) => {
      assert.equal(error.code, TRANSPORT_ERROR.CONNECT_FAILED)
      assert.match(error.message, /Docker Desktop/)
      assert.match(error.message, /definitely-not-a-real-pipe/, '要说明试过哪个管道')
      return true
    },
  )
  // 负对照：直接抛原始 ENOENT → 用户不知道要启动 Docker Desktop
})

test('DockerClient：默认会依次试两个管道（Docker Desktop 上两个都在）', () => {
  // 只断言候选顺序，不真的连 —— 真机验证在 e2e 里
  assert.equal(DEFAULT_PIPE, '\\\\.\\pipe\\dockerDesktopLinuxEngine')
  assert.equal(LEGACY_PIPE, '\\\\.\\pipe\\docker_engine')
  // 负对照：只试一个管道 → Docker CE（没有 desktop 管道）上直接连不上
})

// ── 跨平台端点解析 ──────────────────────────────────────────────────────────

test('resolveDockerEndpoints：Windows 用命名管道，类 Unix 用 unix socket', () => {
  // 这条很关键：写死命名管道的话，macOS / Linux 上 Docker 后端**完全不可用**。
  const win = resolveDockerEndpoints({ platform: 'win32', env: {} })
  assert.deepEqual(win.endpoints, [DEFAULT_PIPE, LEGACY_PIPE])

  for (const platform of ['linux', 'darwin']) {
    const unix = resolveDockerEndpoints({ platform, env: {} })
    assert.deepEqual(unix.endpoints, ['/var/run/docker.sock', '/run/docker.sock'], `${platform} 应当用 unix socket`)
  }
  // 负对照：只返回 Windows 命名管道 → Linux/macOS 上每个 Docker 操作都连不上
})

test('resolveDockerEndpoints：DOCKER_HOST 优先（用户比我们清楚守护进程在哪）', () => {
  const npipe = resolveDockerEndpoints({ platform: 'win32', env: { DOCKER_HOST: 'npipe:////./pipe/custom' } })
  assert.deepEqual(npipe.endpoints, ['\\\\.\\pipe\\custom'])
  assert.equal(npipe.source, 'DOCKER_HOST(npipe)')

  const unix = resolveDockerEndpoints({ platform: 'linux', env: { DOCKER_HOST: 'unix:///tmp/docker.sock' } })
  assert.deepEqual(unix.endpoints, ['/tmp/docker.sock'])
  assert.equal(unix.source, 'DOCKER_HOST(unix)')
  // 负对照：忽略 DOCKER_HOST → 连到错误的守护进程（可能是另一台机器的）
})

test('resolveDockerEndpoints：tcp:// 与 ssh:// 明确不支持，不假装能连', () => {
  for (const host of ['tcp://1.2.3.4:2375', 'ssh://user@host']) {
    const resolved = resolveDockerEndpoints({ platform: 'linux', env: { DOCKER_HOST: host } })
    assert.deepEqual(resolved.endpoints, [], `${host} 不应当产生候选端点`)
    assert.ok(resolved.unsupported !== undefined, '应当说明为什么不支持')
    assert.match(resolved.unsupported, /tcp:\/\/ 与 ssh:\/\//)
  }
  // 负对照：把 tcp:// 当 unix socket 用 → 报一个看不懂的 ENOENT
})

test('DockerClient：DOCKER_HOST 是 tcp:// 时明确报「不支持」，不静默失败', () => {
  const client = new DockerClient({ env: { DOCKER_HOST: 'tcp://1.2.3.4:2375' } })
  return assert.rejects(
    () => client.handshake({ timeoutMs: 2000 }),
    (error) => {
      assert.equal(error.code, TRANSPORT_ERROR.CONNECT_FAILED)
      assert.match(error.message, /tcp:\/\/ 与 ssh:\/\//)
      return true
    },
  )
  // 负对照：报一个笼统的「连不上」→ 用户去检查 Docker Desktop，而问题在 DOCKER_HOST
})
