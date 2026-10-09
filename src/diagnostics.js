/**
 * 后端可用性探测 —— 回答「这台机器上，三种后端各自能不能用」。
 *
 * ## 为什么需要
 *
 * 三种后端的前置条件完全不同，而且失败方式很容易让人摸不着头脑：
 *
 * | 后端 | 前置条件 | 不满足时用户看到 |
 * |---|---|---|
 * | SSH | 可达的 sshd + 账号 | 连接超时 —— 可能是网络、可能是防火墙，用户不知道从哪查 |
 * | WSL | Windows + WSL2 + 发行版 | 「找不到发行版」—— 但用户可能根本没装 WSL |
 * | Docker | 守护进程在跑 | 「连不上 Docker 守护进程」—— 可能只是 Docker Desktop 没启动 |
 *
 * 所以自检里应当**先回答「能不能用」**，再去谈具体连接。
 * 这些探测都**只读、无副作用、不碰用户数据**：列发行版、握手守护进程、看平台。
 *
 * ## 诚实原则
 *
 * - 探不到就报 `unknown` 并给出**原始错误**，不猜。
 * - **绝不**把「能列出东西」说成「连得上」—— 那需要凭据，自检不该要凭据。
 *   所以 SSH 那条永远只说「客户端可用」，不说「你的服务器连得上」。
 */
import { listDistros } from './transport/wsl.js'
import { DockerClient } from './transport/docker.js'

/** 一次探测最多等多久（毫秒）。自检不该让界面转很久。 */
const PROBE_TIMEOUT_MS = 8_000

/** 把探测结果收敛成稳定形状。 */
function result(status, detail, extra = {}) {
  return { status, detail, ...extra }
}

/**
 * SSH：只报「这个平台上的客户端能力」，**不猜服务器**。
 *
 * 为什么不去连：自检不该要凭据，也不该在用户没让你连的时候发连接。
 */
export async function probeSsh() {
  return result(
    'client-ready',
    'SSH 客户端在本平台可用；能不能连上取决于目标 sshd 与账号（连接时才验证）',
    { platform: process.platform },
  )
}

/**
 * WSL：只在 Windows 上有意义。
 *
 * `wsl -l -q` **不会启动发行版**（实测：冷的时候只要 50–60 ms），
 * 所以这个探测是安全的、不会拖慢自检。
 */
export async function probeWsl(options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') {
    return result('unsupported', 'WSL 只在 Windows 上存在')
  }
  try {
    const distros = await listDistros()
    if (distros.length === 0) {
      return result('unavailable', '这台机器上没有安装任何 WSL 发行版')
    }
    return result('available', `找到 ${distros.length} 个发行版`, { distros })
  } catch (error) {
    return result('unknown', `探测失败：${error?.message ?? error}`)
  }
}

/**
 * Docker：握手守护进程（`GET /version`），**不碰任何容器**。
 *
 * 端点按平台解析，所以这条也能顺带告诉类 Unix 用户「我们在找哪个 socket」。
 */
export async function probeDocker(options = {}) {
  const client = new DockerClient(options.dockerClientOptions ?? {})
  try {
    const handshake = await client.handshake({ timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS })
    return result('available', `守护进程 ${handshake.serverVersion || '(未知版本)'}，API ${handshake.apiVersion}`, {
      endpoint: handshake.pipe,
      apiVersion: handshake.apiVersion,
      serverVersion: handshake.serverVersion,
      osType: handshake.osType,
    })
  } catch (error) {
    return result('unavailable', error?.message ?? String(error), {
      endpoints: client.endpoints,
    })
  }
}

/**
 * 一次把所有后端探完。
 *
 * 刻意**并行**：三个探测互不依赖，串行会让自检白等三倍时间。
 * 任何一个失败都不影响其他 —— 这正是「探测」该有的语义。
 *
 * @returns {Promise<Record<'ssh'|'wsl'|'docker', {status: string, detail: string}>>}
 */
export async function probeBackends(options = {}) {
  const [ssh, wsl, docker] = await Promise.all([
    probeSsh(options).catch((error) => result('unknown', String(error?.message ?? error))),
    probeWsl(options).catch((error) => result('unknown', String(error?.message ?? error))),
    probeDocker(options).catch((error) => result('unknown', String(error?.message ?? error))),
  ])
  return { ssh, wsl, docker }
}

/**
 * 列**可以连的目标** —— 给界面用（不是自检）。
 *
 * 与 `probeBackends` 的区别：那个回答「能不能用」，这个回答「有哪些可以点」。
 * 这样界面就不用让用户**盲填**发行版名 / 容器名 —— 那些填错了连接照样「成功」，
 * 但之后每条命令都失败，非常难排查。
 *
 * 两条都是**只读、无副作用**的：列发行版**不会启动**它（`wsl -l -q` 实测 50–60 ms），
 * 列容器不碰容器内部。
 *
 * ⚠️ 刻意**不**列 SSH 的候选 —— 那需要凭据，而这个函数不该要凭据。
 * SSH 走的是「已保存的连接」（`profiles`，只存非敏感字段）。
 */
export async function listTargets(options = {}) {
  const [wsl, docker] = await Promise.all([
    listWslDistros(options).catch((error) => result('unknown', `探测失败：${error?.message ?? error}`, { distros: [] })),
    listDockerContainers(options).catch((error) => result('unknown', `探测失败：${error?.message ?? error}`, { containers: [] })),
  ])
  return { wsl, docker }
}

/**
 * Docker Desktop 自己装的 WSL 发行版（`docker-desktop` / `docker-desktop-data`）。
 *
 * ⚠️ **实测会出现在 `wsl -l -q` 里** —— 它是**货真价实的 WSL2 发行版**
 * （注册表 `Lxss` 里有它的 BasePath，`wsl -l -v` 列得出来），
 * 只是它不是给人写代码用的：里面是 Docker 的 `/var/lib/docker`。
 *
 * **所以我们只「标记」不「隐藏」**：隐藏会让列表和 `wsl -l -q` 对不上，
 * 用户会以为插件漏了；而且按名字硬编码的隐藏换个工具就漏判。
 */
const WSL_SYSTEM_DISTRO = /^docker-desktop(-data)?$/i

/**
 * WSL：列出已安装的发行版（**不启动**它们），并标出哪些是「系统发行版」。
 *
 * `distros` 是**完整**列表（与 `wsl -l -q` 一致）；`systemDistros` 是其中
 * 看起来像系统 VM 的子集，界面据此**标注**（而不是丢掉）。
 */
async function listWslDistros(options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') {
    return result('unsupported', 'WSL 只在 Windows 上存在', { distros: [], systemDistros: [] })
  }
  // 可注入：测试不该真的去跑 `wsl.exe`
  const readDistros = options.listDistros ?? listDistros
  try {
    const all = await readDistros()
    if (all.length === 0) {
      return result('unavailable', '这台机器上没有安装任何 WSL 发行版', { distros: [], systemDistros: [] })
    }
    const systemDistros = all.filter((name) => WSL_SYSTEM_DISTRO.test(String(name)))
    const usable = all.length - systemDistros.length
    const detail = usable > 0
      ? `找到 ${all.length} 个发行版`
      : `只有 Docker Desktop 的系统发行版（${systemDistros.join('、')}）`
    return result('available', detail, { distros: all, systemDistros })
  } catch (error) {
    return result('unknown', `探测失败：${error?.message ?? error}`, { distros: [], systemDistros: [] })
  }
}

/** Docker：列出容器（运行中的排在前面）。守护进程没跑就如实报不可用。 */
async function listDockerContainers(options = {}) {
  const client = new DockerClient(options.dockerClientOptions ?? {})
  try {
    const raw = await client.listContainers({ all: true, timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS })
    const containers = raw
      .map((entry) => ({
        id: String(entry?.Id ?? '').slice(0, 12),
        name: Array.isArray(entry?.Names) && entry.Names.length > 0
          ? String(entry.Names[0]).replace(/^\//, '')
          : '',
        image: String(entry?.Image ?? ''),
        state: String(entry?.State ?? ''),
        status: String(entry?.Status ?? ''),
        running: entry?.State === 'running',
      }))
      .filter((entry) => entry.id !== '')
      .sort((a, b) => Number(b.running) - Number(a.running))
    return result(
      'available',
      containers.length === 0 ? '守护进程可用，但没有任何容器' : `找到 ${containers.length} 个容器`,
      { containers, endpoint: client.endpoints },
    )
  } catch (error) {
    return result('unavailable', error?.message ?? String(error), { containers: [], endpoints: client.endpoints })
  }
}
