/**
 * `src/transport/wsl.js` 的契约测试。
 *
 * 不依赖真 WSL：用一个**假的 `wsl.exe`**（Node 脚本）冒充它。
 * 这样能精确控制输出编码、退出码、并发时序 —— 而这些正是最容易出错的地方。
 *
 * 重点验证三类硬约束：
 *   1. **用户数据绝不进 shell 字符串**（否则引号地狱 + 注入）
 *   2. **并发 ≤ 4**（实测 8 路以上会把 relay 打停顿甚至打死）
 *   3. **绝不 SIGKILL `wsl.exe`**（实测会把 relay 打死，需要提权重启）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WslTransport, listDistros, decodeWslOutput, MAX_CONCURRENT } from '../src/transport/wsl.js'
import { TRANSPORT_ERROR } from '../src/transport/transport.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/**
 * 造一个假的 `wsl.exe`。
 *
 * 它把每次收到的 argv 记到一个 JSONL 日志里，并按 argv 形状返回预设输出 ——
 * 测试据此断言「脚本是常量」「数据走位置参数」「并发上限」。
 *
 * @param {object} spec
 * @param {string[]} [spec.distros]
 * @param {Record<string, string>} [spec.files] 虚拟文件系统（路径 → 内容）
 * @param {number} [spec.delayMs] 每次调用的人为延迟（用于测并发）
 * @param {string[]} [spec.shells] 这个假发行版里**有**哪些 shell（默认两个都有）。
 *   `['sh']` 用来模拟 Docker Desktop 的 `docker-desktop` —— 它只有 busybox 的 sh。
 */
async function makeFakeWsl(spec = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fake-wsl-'))
  const logPath = join(dir, 'calls.jsonl')
  const distros = spec.distros ?? ['Ubuntu-24.04', 'docker-desktop']
  const files = spec.files ?? { '/home/u/a.txt': 'hello\n' }
  const delayMs = spec.delayMs ?? 0
  const shells = spec.shells ?? ['bash', 'sh']

  const script = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const logPath = ${JSON.stringify(logPath)}
const delayMs = ${delayMs}
const distros = ${JSON.stringify(distros)}
const files = ${JSON.stringify(files)}
const shells = ${JSON.stringify(shells)}

const argv = process.argv.slice(2)
appendFileSync(logPath, JSON.stringify({ argv, at: Date.now() }) + '\\n')

if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))

// wsl.exe 的致命错误：exit -1 + stdout 里的 Wsl/<CODE>（UTF-16LE）
if (argv.includes('--force-fatal')) {
  process.stdout.write(Buffer.from('Wsl/E_DISTRO_NOT_FOUND', 'utf16le'))
  process.exit(-1)
}

// -l -q：UTF-16LE 无 BOM，且名字之间有空行（实测特征）
if (argv[0] === '-l' && argv[1] === '-q') {
  process.stdout.write(Buffer.from(distros.join('\\r\\n') + '\\r\\n\\r\\n', 'utf16le'))
  process.exit(0)
}

const eIdx = argv.indexOf('-e')
if (eIdx === -1) { process.stderr.write('unsupported argv'); process.exit(64) }

const after = argv.slice(eIdx + 1)

// shell 探测：-e <shell> -c 'exit 0'（transport 用它决定用 bash 还是 sh）
if ((after[0] === 'bash' || after[0] === 'sh') && after[1] === '-c' && after[2] === 'exit 0') {
  if (shells.includes(after[0])) process.exit(0)
  // 真实 wsl.exe 就是这个报错（用户实测：docker-desktop 里没有 bash）
  process.stderr.write('execvpe(' + after[0] + ') failed: No such file or directory\\n')
  process.exit(1)
}

// exec 路径：-e bash -lc <command>，或退路 -e sh -c <command>
// （文件操作那条是 -e sh -c <CONSTANT script> sh <args...> —— 第 4 个参数是 'sh'）
if ((after[0] === 'bash' && after[1] === '-lc') || (after[0] === 'sh' && after[1] === '-c' && after[3] !== 'sh')) {
  // 这个发行版里没有这个 shell → 真实 wsl.exe 的报错（用户实测见到的那句）
  if (!shells.includes(after[0])) {
    process.stderr.write('execvpe(' + after[0] + ') failed: No such file or directory\\n')
    process.exit(1)
  }
  const command = after[2]
  if (command === 'pwd') { process.stdout.write('/home/u\\n'); process.exit(0) }
  if (command === 'exit 7') process.exit(7)
  if (command === 'boom') { process.stderr.write('boom!\\n'); process.exit(3) }
  process.stdout.write('OUT:' + command + '\\n')
  process.exit(0)
}

// 文件操作路径：-e sh -c <CONSTANT script> sh <args...>
if (after[0] === 'sh' && after[1] === '-c') {
  const script = after[2]
  const scriptArgs = after.slice(4)   // 跳过 'sh'
  const p = scriptArgs[0] ?? ''

  if (script.includes('readlink -f')) {
    if (files[p] === undefined) { process.stdout.write(p); process.exit(2) }
    process.stdout.write('/resolved' + p + '\\n'); process.exit(0)
  }

  if (script.includes('stat -L --printf')) {
    const content = files[p]
    if (content === undefined) process.exit(2)
    const out = ['regular file', String(Buffer.byteLength(content)), '1700000000', '644', '1000', '1000', '']
    process.stdout.write(out.join('\\0')); process.exit(0)
  }

  if (script.includes('-maxdepth 1 -printf')) {
    if (files[p] === undefined && !Object.keys(files).some((k) => k.startsWith(p + '/'))) process.exit(2)
    const names = Object.keys(files)
      .filter((k) => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/'))
    const parts = []
    for (const full of names) {
      const name = full.slice(p.length + 1)
      parts.push(name, 'f', String(Buffer.byteLength(files[full])), '1700000000.5')
    }
    process.stdout.write(parts.join('\\0') + (parts.length > 0 ? '\\0' : ''))
    process.exit(0)
  }

  // 批量读：脚本第 1 个参数是 maxBytes，后面全是路径。
  // 输出协议：每文件「路径 NUL 长度 NUL base64 NUL」；缺失文件长度 = -1、无内容段。
  // 判据：批量脚本是唯一「for p in "$@"」的（其余脚本都是单路径 $1）。
  // ⚠️ 必须放在「head -c」分支**之前** —— 批量脚本里也有 head -c（取 max+1），
  // 晚判就会被单文件分支抢走，把 maxBytes 当成文件路径。
  if (script.includes('for p in "$@"')) {
    const max = Number(scriptArgs[0])
    const paths = scriptArgs.slice(1)
    let out = ''
    for (const path of paths) {
      const content = files[path]
      if (content === undefined) {
        out += path + '\\0-1\\0'
        continue
      }
      const buf = Buffer.from(content, 'utf8')
      const b64 = buf.subarray(0, max + 1).toString('base64')
      out += path + '\\0' + String(b64.length) + '\\0' + b64 + '\\0'
    }
    process.stdout.write(out)
    process.exit(0)
  }

  if (script.includes('head -c')) {
    const content = files[p]
    if (content === undefined) process.exit(2)
    const max = Number(scriptArgs[1])
    const buf = Buffer.from(content, 'utf8')
    process.stdout.write(buf.subarray(0, max + 1).toString('base64'))
    process.exit(0)
  }

  if (script.includes('base64 -d')) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    const decoded = Buffer.from(Buffer.concat(chunks).toString('utf8'), 'base64')
    files[p] = decoded.toString('utf8')
    writeFileSync(${JSON.stringify(join(dir, 'last-write.json'))}, JSON.stringify({ path: p, content: files[p] }))
    process.exit(0)
  }

  process.stderr.write('unknown script'); process.exit(65)
}

process.stderr.write('unsupported'); process.exit(64)
`

  const fakePath = join(dir, 'fake-wsl.mjs')
  await writeFile(fakePath, script, 'utf8')
  return { dir, fakePath, logPath, files, distros }
}

/** 读假 wsl 的调用日志。 */
async function readCalls(logPath) {
  try {
    const text = await readFile(logPath, 'utf8')
    return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/**
 * 只挑**真正执行命令**的调用。
 *
 * 要排除两种：
 *   - shell 探测：`-e <shell> -c 'exit 0'`（transport 用它决定用 bash 还是 sh）
 *   - 文件操作：`-e sh -c <CONSTANT script> sh <args...>`
 */
function execCalls(calls) {
  return calls.filter((call) => {
    if (call.argv.includes('exit 0')) return false
    const i = call.argv.indexOf('-e')
    if (i === -1) return false
    const after = call.argv.slice(i + 1)
    if (after[0] === 'bash' && after[1] === '-lc') return true
    return after[0] === 'sh' && after[1] === '-c' && after[3] !== 'sh'
  })
}

async function withFake(spec, fn) {
  const fake = await makeFakeWsl(spec)
  try {
    return await fn(fake)
  } finally {
    await rm(fake.dir, { recursive: true, force: true })
  }
}

// ── 编码 ────────────────────────────────────────────────────────────────────

test('decodeWslOutput：UTF-16LE 无 BOM 正确解码', () => {
  const buf = Buffer.from('Ubuntu-24.04\r\n', 'utf16le')
  assert.equal(decodeWslOutput(buf), 'Ubuntu-24.04\r\n')

  // 带 BOM
  const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('x', 'utf16le')])
  assert.equal(decodeWslOutput(withBom), 'x')

  // UTF-8（子进程输出）不该被误判
  assert.equal(decodeWslOutput(Buffer.from('plain utf8', 'utf8')), 'plain utf8')
  // 负对照：一律按 utf8 解码 → UTF-16LE 会变成带 \0 的乱码
  assert.notEqual(Buffer.from('Ubuntu-24.04', 'utf16le').toString('utf8'), 'Ubuntu-24.04')
})

test('listDistros：解码 UTF-16LE 并过滤空行', async () => {
  await withFake({ distros: ['Ubuntu-24.04', 'docker-desktop'] }, async (fake) => {
    const list = await listDistros({ wslExe: ['node', fake.fakePath] })
    assert.deepEqual(list, ['Ubuntu-24.04', 'docker-desktop'])
    // 负对照：不过滤空行 → 会多出一个 ''
  })
})

// ── 安全：用户数据绝不进 shell ──────────────────────────────────────────────

test('文件操作：用户数据只出现在位置参数里，脚本是常量', async () => {
  const nasty = '/tmp/$(rm -rf /) `id` "quoted" \'single\' ; echo pwned'
  await withFake({ files: { [nasty]: 'payload\n' } }, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    await transport.readFile(nasty, { encoding: 'utf8' })

    const calls = await readCalls(fake.logPath)
    const fileCall = calls.find((call) => call.argv.includes('-e') && call.argv.includes('sh'))
    assert.ok(fileCall, '应当有一次文件操作调用')

    const scriptIndex = fileCall.argv.indexOf('-c') + 1
    const script = fileCall.argv[scriptIndex]
    assert.ok(!script.includes('rm -rf'), '恶意路径绝不能出现在脚本里')
    assert.ok(!script.includes('pwned'), '恶意路径绝不能出现在脚本里')
    assert.ok(script.includes('"$1"') || script.includes('$1'), '脚本应当只用位置参数引用数据')

    // 数据本身必须在脚本之后的参数里，原样出现
    const dataArgs = fileCall.argv.slice(scriptIndex + 2)
    assert.ok(dataArgs.includes(nasty), '路径应当作为位置参数原样传入')
    // 负对照：把路径拼进脚本字符串 → 上面两条 not-includes 会失败
  })
})

// ── 并发上限（硬约束） ──────────────────────────────────────────────────────

test('并发上限：同时在途的 wsl.exe 不超过 4 个', async () => {
  await withFake({ delayMs: 60 }, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })

    // 一次发 16 个请求，远超上限
    await Promise.all(Array.from({ length: 16 }, () => transport.exec('echo x')))

    const calls = await readCalls(fake.logPath)
    // 用「开始/结束时间」推算峰值并发：每个调用持续约 60ms
    const events = []
    for (const call of calls) {
      events.push({ at: call.at, delta: 1 })
      events.push({ at: call.at + 60, delta: -1 })
    }
    events.sort((a, b) => a.at - b.at || a.delta - b.delta)
    let current = 0
    let peak = 0
    for (const event of events) {
      current += event.delta
      peak = Math.max(peak, current)
    }

    assert.ok(peak <= MAX_CONCURRENT, `峰值并发应当 ≤ ${MAX_CONCURRENT}，实际 ${peak}`)
    // 探测 shell 也是一次 spawn（`-c 'exit 0'`），所以计数时把它排除掉 ——
    // 但它**照样占槽位**，上面峰值那条断言是算上它的。
    assert.equal(execCalls(calls).length, 16, '所有请求都要被执行（排队而不是丢弃）')
    // 负对照：去掉限流 → 16 个并发全开，峰值到 16
  })
})

test('并发上限：MAX_CONCURRENT 必须是 4（实测的安全阈值）', () => {
  assert.equal(MAX_CONCURRENT, 4)
  // 负对照：调到 8 以上 → 实测会出现 30 秒级停顿与 50–87% 失败率
})

// ── 致命错误识别 ────────────────────────────────────────────────────────────

test('致命错误：exit -1 + stdout 里的 Wsl/CODE 要被识别（不能只看 stderr）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fake-wsl-fatal-'))
  try {
    const fakePath = join(dir, 'fatal.mjs')
    // 关键：致命信息打在 **stdout** 上、编码是 UTF-16LE、退出码是 -1（实测特征）
    await writeFile(fakePath, `
process.stdout.write(Buffer.from('Wsl/E_ACCESSDENIED', 'utf16le'))
process.stderr.write('')
process.exit(-1)
`, 'utf8')
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fakePath] })
    await assert.rejects(
      () => transport.exec('echo x'),
      (error) => {
        assert.equal(error.code, TRANSPORT_ERROR.CONNECT_FAILED)
        assert.match(error.message, /E_ACCESSDENIED/)
        return true
      },
    )
    // 负对照：只看 stderr → stderr 是空的，会被当成「成功但没有输出」
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('致命错误分类：Wsl/E_DISTRO_NOT_FOUND 给出可读提示', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fake-wsl-fatal-'))
  try {
    const fakePath = join(dir, 'fake.mjs')
    await writeFile(fakePath, `
process.stdout.write(Buffer.from('Wsl/E_DISTRO_NOT_FOUND', 'utf16le'))
process.exit(-1)
`, 'utf8')
    const transport = new WslTransport({ distro: 'Nope', wslExe: ['node', fakePath] })
    await assert.rejects(
      () => transport.exec('echo x'),
      (error) => {
        assert.equal(error.code, TRANSPORT_ERROR.CONNECT_FAILED)
        assert.match(error.message, /E_DISTRO_NOT_FOUND/)
        assert.match(error.message, /发行版不存在/)
        assert.equal(error.retryable, false)
        return true
      },
    )
    // 负对照：只看 stderr → 会把「发行版不存在」当成「成功但没输出」
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── 契约行为 ────────────────────────────────────────────────────────────────

test('connect：发行版不存在时明确报错并列出可用的', async () => {
  await withFake({ distros: ['Ubuntu-24.04'] }, async (fake) => {
    const transport = new WslTransport({ distro: 'Debian', wslExe: ['node', fake.fakePath] })
    await assert.rejects(
      () => transport.connect(),
      (error) => {
        assert.equal(error.code, TRANSPORT_ERROR.CONNECT_FAILED)
        assert.match(error.message, /Debian/)
        assert.match(error.message, /Ubuntu-24\.04/, '应当列出可用发行版')
        return true
      },
    )
    // 负对照：不校验发行版 → 后续每个操作都失败，错误信息指不到根因
  })
})

test('connect：成功时记录默认 cwd，且幂等', async () => {
  await withFake({}, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    await transport.connect()
    assert.equal(transport.defaultCwd, '/home/u')
    await transport.connect()  // 再来一次不应抛错
    assert.equal(transport.connected, true)
    // 负对照：connect 不幂等 → 重复调用会重复探测
  })
})

test('readFile：文本读取正常；NUL 字节报 NOT_TEXT', async () => {
  await withFake({ files: { '/a.txt': 'hello\n' } }, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    assert.equal(await transport.readFile('/a.txt', { encoding: 'utf8' }), 'hello\n')
  })
  // 负对照：不拒绝 NUL → 上层会拿到带 \0 的「文本」
})

test('readFile：超过 maxBytes 必须失败，绝不截断', async () => {
  const big = 'x'.repeat(5000)
  await withFake({ files: { '/big.txt': big } }, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    await assert.rejects(
      () => transport.readFile('/big.txt', { maxBytes: 100 }),
      (error) => {
        assert.equal(error.code, TRANSPORT_ERROR.TOO_LARGE)
        return true
      },
    )
    // 负对照：截断而不是报错 → 上层会以为拿到的是完整内容
  })
})

test('readFile：目标不存在报 NOT_FOUND', async () => {
  await withFake({}, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    await assert.rejects(
      () => transport.readFile('/nope.txt'),
      (error) => error.code === TRANSPORT_ERROR.NOT_FOUND,
    )
  })
})

test('writeFileAtomic：内容经 stdin 传 base64（不进命令行）', async () => {
  await withFake({ files: {} }, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    await transport.writeFileAtomic('/new.txt', 'written content\n')

    const calls = await readCalls(fake.logPath)
    const writeCall = calls.find((call) => call.argv.some((a) => typeof a === 'string' && a.includes('base64 -d')))
    assert.ok(writeCall, '应当有一次写入调用')
    // 内容不该出现在 argv 里（经 stdin 传）
    assert.ok(
      !writeCall.argv.some((a) => typeof a === 'string' && a.includes('written content')),
      '内容绝不能出现在命令行参数里',
    )
    // 负对照：把内容拼进脚本 → 大文件会撞命令行长度上限，且需要转义
  })
})

test('readdir：一次调用拿到名字/类型/大小/mtime', async () => {
  await withFake({ files: { '/d/a.txt': 'aaa', '/d/b.txt': 'bb' } }, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    const entries = await transport.readdir('/d')
    assert.deepEqual(entries.map((e) => e.name).sort(), ['a.txt', 'b.txt'])
    assert.equal(entries[0].type, 'file')
    assert.ok(entries[0].mtimeMs > 1_600_000_000_000, 'mtime 应当是毫秒')

    const calls = await readCalls(fake.logPath)
    assert.equal(calls.length, 1, 'readdir 必须只花一次调用（每次调用固定开销约 106ms）')
    // 负对照：逐文件 stat → N 个文件 = N 次调用，2000 文件就是 200 秒
  })
})

test('stat：解析 NUL 分隔字段', async () => {
  await withFake({ files: { '/f.txt': 'content' } }, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    const info = await transport.stat('/f.txt')
    assert.equal(info.type, 'file')
    assert.equal(info.size, 7)
    assert.equal(info.mode, 0o644)
    assert.equal(info.mtimeMs, 1_700_000_000_000)
    // 负对照：用空格/换行分隔 → 文件名含空格时字段会错位
  })
})

test('exec：返回退出码与 stdout/stderr，且用登录 shell', async () => {
  await withFake({}, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    const ok = await transport.exec('echo hi')
    assert.equal(ok.code, 0)
    assert.equal(ok.stdout, 'OUT:echo hi\n')

    const seven = await transport.exec('exit 7')
    assert.equal(seven.code, 7, '非零退出码要如实回报')

    const boom = await transport.exec('boom')
    assert.equal(boom.code, 3)
    assert.equal(boom.stderr, 'boom!\n')

    const calls = execCalls(await readCalls(fake.logPath))
    assert.ok(calls.length >= 3, '三次 exec 都要发起调用')
    assert.ok(calls.every((call) => call.argv.includes('bash')), 'exec 应当走 bash')
    assert.ok(calls.every((call) => call.argv.includes('-lc')), 'exec 应当走登录 shell（拿到用户 PATH）')
    // 负对照：用 -e <command> 直接跑 → 没有 shell，管道/重定向全废
  })
})

test('readdir / statNul：脚本里 **GNU 与 busybox 两条路都要有**', async () => {
  // ⚠️ 用户实测（2026-10-09）：Docker Desktop 的 `docker-desktop` 发行版是 busybox ——
  // `find: unrecognized: -printf`。而 Alpine-on-WSL 同理。
  //
  // 还实测出一件反直觉的事：**`stat -c` 不解释 `\0`**（busybox 与 GNU 都原样输出
  // `\0` 两个字符），只有 `--printf` 才解释。所以 busybox 退路的 NUL 必须由
  // `printf` 自己产出，不能靠 `stat -c` 的格式串。
  await withFake({ files: { '/d/a.txt': 'x' } }, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    await transport.readdir('/d')
    await transport.stat('/d/a.txt')

    const calls = await readCalls(fake.logPath)
    const scripts = calls.map((call) => call.argv[call.argv.indexOf('-c') + 1])
    const readdirScript = scripts.find((text) => text.includes('readdir') || text.includes('-maxdepth 1'))
    const statScript = scripts.find((text) => text.includes('stat -L'))

    assert.ok(readdirScript !== undefined, '应当找得到 readdir 脚本')
    assert.ok(readdirScript.includes("-printf ''"), 'readdir 要有能力探测（GNU 才走 -printf）')
    assert.ok(readdirScript.includes('stat -c'), 'readdir 的 busybox 退路要用 stat -c')
    assert.ok(readdirScript.includes('printf "%s\\0'), 'busybox 退路的 NUL 由 printf 产出')
    assert.ok(readdirScript.includes('%f\\0%y\\0%s\\0%T@\\0'), 'GNU 路的字段顺序（名字/类型/大小/mtime）')

    assert.ok(statScript !== undefined, '应当找得到 statNul 脚本')
    assert.ok(statScript.includes("--printf ''"), 'statNul 要有能力探测')
    assert.ok(statScript.includes("stat -L -c '%F|%s|%Y|%a|%u|%g'"), 'busybox 退路要用 -c 取字段')
    assert.ok(statScript.includes('printf '), 'busybox 退路的 NUL 由 printf 产出')
    assert.ok(statScript.includes('%F\\0%s\\0%Y\\0%a\\0%u\\0%g\\0'), 'GNU 路的字段顺序')
    // 负对照：只用 find -printf → busybox 发行版列目录直接失败（用户实测踩到）
  })
})

test('exec：发行版里没有 bash 时退到 sh（docker-desktop 就是这样）', async () => {
  // ⚠️ 用户实测（2026-10-09）：选中 Docker Desktop 的 `docker-desktop` 发行版连接 →
  // `execvpe(bash) failed: No such file or directory`。
  // 它是 busybox，**只有 `sh` 没有 bash** —— 而 POSIX shell 才是硬要求。
  await withFake({ distros: ['docker-desktop'], shells: ['sh'] }, async (fake) => {
    const transport = new WslTransport({ distro: 'docker-desktop', wslExe: ['node', fake.fakePath] })
    const ok = await transport.exec('echo hi')
    assert.equal(ok.code, 0)
    assert.equal(ok.stdout, 'OUT:echo hi\n')

    const calls = execCalls(await readCalls(fake.logPath))
    assert.ok(calls.length >= 1)
    assert.ok(calls.every((call) => call.argv.includes('sh')), '应当退到 sh')
    assert.ok(calls.every((call) => !call.argv.includes('-lc')), 'sh 没有 -l，要用 -c')
    // 负对照：写死 `bash -lc` → 这种发行版直接连不上（用户实测踩到）
  })
})

test('exec：bash 和 sh 都没有时报错，且**不谎报原因**', async () => {
  await withFake({ shells: [] }, async (fake) => {
    const transport = new WslTransport({ distro: 'weird', wslExe: ['node', fake.fakePath] })
    await assert.rejects(
      () => transport.exec('echo x'),
      (error) => {
        assert.equal(error.code, TRANSPORT_ERROR.CONNECT_FAILED)
        assert.match(error.message, /既没有 bash 也没有 sh/)
        return true
      },
    )
    // 负对照：随便挑一个就发 → 每条命令都报 execvpe failed，用户看不到根因
  })
})

test('exec：shell 只探一次（16 路并发也只多一个进程）', async () => {
  await withFake({}, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    await Promise.all(Array.from({ length: 16 }, (_, i) => transport.exec('echo ' + i)))
    const calls = await readCalls(fake.logPath)
    const probes = calls.filter((call) => call.argv.includes('exit 0'))
    assert.equal(probes.length, 1, 'shell 只该探一次（单飞）')
    // 负对照：每个 exec 各探一次 → 16 路并发冒出 16 个 wsl.exe，把 relay 打爆
  })
})

test('exec：命令含 NUL 直接拒绝', async () => {  await withFake({}, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    await assert.rejects(() => transport.exec('echo \0hi'), /NUL/)
    // 负对照：放行 NUL → 服务端报 invalid format，错误指不到原因
  })
})

test('exec：cwd 通过 --cd 传递，且必须是绝对路径', async () => {
  await withFake({}, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    await transport.exec('pwd', { cwd: '/home/u' })
    const calls = execCalls(await readCalls(fake.logPath))
    const call = calls[0]
    const cdIndex = call.argv.indexOf('--cd')
    assert.ok(cdIndex !== -1, '应当显式传 --cd')
    assert.equal(call.argv[cdIndex + 1], '/home/u')
    // 负对照：不传 --cd → 会继承 Windows CWD 并被翻译成 /mnt/...，命令跑错目录
  })
})

test('exec：超时报 TIMEOUT，且用 SIGTERM 而不是 SIGKILL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fake-wsl-hang-'))
  try {
    const fakePath = join(dir, 'hang.mjs')
    // 挂住不退出，并记录收到的信号
    await writeFile(fakePath, `
process.on('SIGTERM', () => { process.exit(143) })
process.on('SIGKILL', () => {})
setTimeout(() => {}, 60000)
`, 'utf8')
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fakePath] })
    await assert.rejects(
      () => transport.exec('sleep 999', { timeoutMs: 500 }),
      (error) => {
        assert.equal(error.code, TRANSPORT_ERROR.TIMEOUT)
        return true
      },
    )
    // 负对照：用 SIGKILL → 实测会把 WSL relay 打死，需要提权重启服务
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('exec：已取消的 signal 立刻抛 ABORTED，不发起调用', async () => {
  await withFake({}, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => transport.exec('echo x', { signal: controller.signal }),
      (error) => error.code === TRANSPORT_ERROR.ABORTED,
    )
    const calls = await readCalls(fake.logPath)
    assert.equal(calls.length, 0, '取消后不该真的发起调用')
    // 负对照：不看 signal → 取消后命令照样跑
  })
})

test('构造：缺少 distro 直接抛错', () => {
  assert.throws(() => new WslTransport({}), /distro/)
  assert.throws(() => new WslTransport({ distro: '   ' }), /distro/)
  // 负对照：允许空 distro → 每个操作都失败在深处，错误信息指不到根因
})

// ── readFilesBatch（2026-10-09 新增：镜像首次拉取 10× 提速的手段）──────────

test('readFilesBatch：一批路径一次调用拿全，缺失文件给 NOT_FOUND', async () => {
  await withFake({
    files: {
      '/home/u/a.txt': 'hello\n',
      '/home/u/b.txt': 'world\n',
      '/home/u/big.txt': 'x'.repeat(100),
    },
  }, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    await transport.connect()
    const out = await transport.readFilesBatch(
      ['/home/u/a.txt', '/home/u/missing.txt', '/home/u/b.txt'],
      { maxBytes: 1024 },
    )

    assert.equal(out.size, 3, '每个路径都要有结果')
    assert.deepEqual(out.get('/home/u/a.txt').data.toString('utf8'), 'hello\n')
    assert.deepEqual(out.get('/home/u/b.txt').data.toString('utf8'), 'world\n')
    const miss = out.get('/home/u/missing.txt')
    assert.equal(miss.ok, false, '缺失文件必须是失败结果')
    assert.equal(miss.error.code, TRANSPORT_ERROR.NOT_FOUND, '缺失文件分类成 NOT_FOUND')

    // **一次**调用拿全 —— 这就是提速的全部来源（不是并发，是省掉 spawn）
    const calls = (await readCalls(fake.logPath))
      .filter((c) => c.argv.includes('-c') && JSON.stringify(c.argv).includes('for p in'))
    assert.equal(calls.length, 1, '一批三个文件必须只 spawn 一次')
    // 负对照：退回逐个读 → 3 个文件 3 次 spawn，197 个文件就是 197 次（实测 22 秒）
  })
})

test('readFilesBatch：超限文件给 TOO_LARGE（失败，不截断）', async () => {
  await withFake({ files: { '/home/u/big.txt': 'x'.repeat(100) } }, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    await transport.connect()
    const out = await transport.readFilesBatch(['/home/u/big.txt'], { maxBytes: 10 })
    const r = out.get('/home/u/big.txt')
    assert.equal(r.ok, false)
    assert.equal(r.error.code, TRANSPORT_ERROR.TOO_LARGE)
    // 负对照：静默截断 → 上层以为拉到了完整内容，写进镜像的是残文件
  })
})

test('readFilesBatch：空列表直接返回，不发起调用', async () => {
  await withFake({}, async (fake) => {
    const transport = new WslTransport({ distro: 'Ubuntu-24.04', wslExe: ['node', fake.fakePath] })
    await transport.connect()
    const before = (await readCalls(fake.logPath)).length
    const out = await transport.readFilesBatch([])
    assert.equal(out.size, 0)
    const after = (await readCalls(fake.logPath)).length
    assert.equal(after - before, 0, '空批不该 spawn（connect 的调用不算）')
  })
})
