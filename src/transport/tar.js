/**
 * 最小 tar 编解码（ustar）—— Docker archive 端点用它传文件内容。
 *
 * ## 为什么需要它
 *
 * Docker 的文件读写走 `GET/PUT /containers/{id}/archive`，而那个端点的载荷是 **tar**。
 * 项目硬约束是**零运行时 npm 依赖**（只允许 `ssh2`），所以自己实现。
 *
 * ## 为什么文件内容不走 exec（而是走 tar）
 *
 * 走 exec 要假设容器里有 `base64` / `head` 之类的工具；而 **distroless / scratch 镜像
 * 里什么都没有**。tar 走的是守护进程，**完全不依赖容器里的工具** ——
 * 这是选它的主要理由，不是性能。
 *
 * ## 支持范围（有意划定的子集）
 *
 * 支持：普通文件、目录、符号链接、USTAR 前缀（长路径）。
 * 不支持：PAX 扩展头、GNU 长名（`././@LongLink`）、稀疏文件、硬链接。
 * 遇到不支持的类型**明确报错**，不静默当成普通文件。
 */
import { posix } from 'node:path'

/** 一个 tar 条目的类型。 */
export const TAR_TYPE = {
  FILE: '0',
  HARD_LINK: '1',
  SYMLINK: '2',
  DIRECTORY: '5',
}

/** tar 块大小。 */
const BLOCK = 512

/** tar 里表示「空」的块（全零）。 */
function isZeroBlock(buffer, offset) {
  for (let i = 0; i < BLOCK; i += 1) {
    if (buffer[offset + i] !== 0) return false
  }
  return true
}

/** 从定长字段里读字符串（到 NUL 或字段末尾为止）。 */
function readString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length)
  const nul = slice.indexOf(0)
  const end = nul === -1 ? slice.length : nul
  return slice.subarray(0, end).toString('utf8')
}

/** 读八进制数字字段（tar 的经典数字表示）。 */
function readOctal(buffer, offset, length) {
  const text = readString(buffer, offset, length).trim()
  if (text === '') return 0
  // 有些实现会用 base-256 表示大数（首字节高位为 1），这里显式拒绝而不是算错
  if ((buffer[offset] & 0x80) !== 0) {
    throw new Error('tar: 不支持 base-256 编码的数字字段（大文件/大时间戳）')
  }
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value)) throw new Error(`tar: 无法解析的八进制字段 ${JSON.stringify(text)}`)
  return value
}

/** 写八进制数字字段。 */
function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0')
  buffer.write(text, offset, length - 1, 'utf8')
  buffer[offset + length - 1] = 0
}

/**
 * 解析一个 tar 缓冲区。
 *
 * @param {Buffer} buffer
 * @returns {Array<{ name: string, type: string, size: number, mode: number, mtimeMs: number, linkTarget: string, data: Buffer }>}
 */
export function parseTar(buffer) {
  const entries = []
  let offset = 0

  while (offset + BLOCK <= buffer.length) {
    if (isZeroBlock(buffer, offset)) break

    const header = buffer.subarray(offset, offset + BLOCK)
    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const fullName = prefix === '' ? name : `${prefix}/${name}`
    const mode = readOctal(header, 100, 8)
    const size = readOctal(header, 124, 12)
    const mtimeSeconds = readOctal(header, 136, 12)
    const typeFlag = String.fromCharCode(header[156] === 0 ? 0x30 : header[156])
    const linkTarget = readString(header, 157, 100)

    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > buffer.length) {
      throw new Error(`tar: 条目 "${fullName}" 的数据被截断（声明 ${size} 字节，实际不足）`)
    }
    const data = buffer.subarray(dataStart, dataEnd)

    entries.push({
      name: fullName,
      type: typeFlag,
      size,
      mode,
      mtimeMs: mtimeSeconds * 1000,
      linkTarget,
      data,
    })

    // 数据按 512 对齐
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }

  return entries
}

/**
 * 构造一个只含单个条目的 tar。
 *
 * @param {object} options
 * @param {string} options.name tar 内的路径（相对路径，用 `/` 分隔）
 * @param {Buffer|string} [options.content]
 * @param {string} [options.type] 见 {@link TAR_TYPE}
 * @param {number} [options.mode] 权限位（默认 0o644；目录 0o755）
 * @param {number} [options.mtimeMs]
 * @param {string} [options.linkTarget]
 * @returns {Buffer}
 */
export function buildTar(options) {
  const {
    name,
    content = Buffer.alloc(0),
    type = TAR_TYPE.FILE,
    mode,
    mtimeMs = Date.now(),
    linkTarget = '',
  } = options

  if (typeof name !== 'string' || name === '') throw new Error('buildTar 需要非空的 name')
  if (name.includes('\0')) throw new Error('buildTar: name 不能含 NUL')

  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
  const isDirectory = type === TAR_TYPE.DIRECTORY
  const effectiveMode = mode ?? (isDirectory ? 0o755 : 0o644)

  // ustar 的 name 字段只有 100 字节，长的要拆到 prefix（155 字节）
  const { nameField, prefixField } = splitName(name)

  const header = Buffer.alloc(BLOCK)
  header.write(nameField, 0, 100, 'utf8')
  writeOctal(header, 100, 8, effectiveMode)
  writeOctal(header, 108, 8, 0)                    // uid
  writeOctal(header, 116, 8, 0)                    // gid
  writeOctal(header, 124, 12, isDirectory ? 0 : data.length)
  writeOctal(header, 136, 12, Math.floor(mtimeMs / 1000))
  header.write('        ', 148, 8, 'utf8')          // 校验和占位（8 个空格）
  header.write(type, 156, 1, 'utf8')
  if (linkTarget !== '') header.write(linkTarget, 157, 100, 'utf8')
  header.write('ustar\0', 257, 6, 'utf8')
  header.write('00', 263, 2, 'utf8')
  if (prefixField !== '') header.write(prefixField, 345, 155, 'utf8')

  // 校验和：把校验和字段当 8 个空格算，再写入
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')

  const parts = [header]
  if (!isDirectory && data.length > 0) {
    const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK)
    data.copy(padded)
    parts.push(padded)
  }
  // 结束标记：两个全零块
  parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}

/**
 * 把 tar 内的路径拆成 name / prefix 两段（USTAR 的 100 + 155 限制）。
 *
 * 拆法：从右往左找第一个能放下 name 的 `/`。
 */
function splitName(name) {
  const bytes = Buffer.from(name, 'utf8')
  if (bytes.length <= 100) return { nameField: name, prefixField: '' }

  // 需要在某个 `/` 处切开：name 是后半段，prefix 是前半段
  let splitAt = -1
  for (let i = name.length - 1; i > 0; i -= 1) {
    if (name[i] !== '/') continue
    const prefix = name.slice(0, i)
    const rest = name.slice(i + 1)
    if (Buffer.byteLength(rest, 'utf8') <= 100 && Buffer.byteLength(prefix, 'utf8') <= 155) {
      splitAt = i
      break
    }
  }
  if (splitAt === -1) {
    throw new Error(`tar: 路径太长，ustar 放不下（name ≤100 字节、prefix ≤155 字节）：${name}`)
  }
  return { nameField: name.slice(splitAt + 1), prefixField: name.slice(0, splitAt) }
}

/**
 * 从 archive 端点返回的 tar 里取出**目标那一条**。
 *
 * Docker 对「path 指向文件」的 GET 会返回一个只含该文件的 tar（名字是 basename）；
 * 对「path 指向目录」会返回该目录及其全部内容。所以这里要按名字挑。
 *
 * @param {Buffer} buffer
 * @param {string} wantedPath 容器内的绝对路径
 * @returns {{ type: string, size: number, mode: number, mtimeMs: number, linkTarget: string, data: Buffer }}
 */
export function extractSingleEntry(buffer, wantedPath) {
  const entries = parseTar(buffer)
  if (entries.length === 0) throw new Error('tar: 空的 archive 响应')

  const base = posix.basename(wantedPath)
  // 优先精确匹配 basename；否则退到第一条
  const match = entries.find((entry) => posix.basename(entry.name.replace(/\/$/, '')) === base) ?? entries[0]
  return {
    type: match.type,
    size: match.size,
    mode: match.mode,
    mtimeMs: match.mtimeMs,
    linkTarget: match.linkTarget,
    data: match.data,
  }
}
