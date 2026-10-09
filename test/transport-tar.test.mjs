/**
 * `src/transport/tar.js` 的契约测试。
 *
 * 这是纯函数层，所以能测得非常彻底 —— 而它恰恰是 Docker 文件传输的正确性根基。
 * 每个用例都配负对照。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseTar, buildTar, extractSingleEntry, TAR_TYPE } from '../src/transport/tar.js'

test('buildTar + parseTar：单文件往返一致', () => {
  const content = 'hello tar\n'
  const tar = buildTar({ name: 'a.txt', content })
  const entries = parseTar(tar)

  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'a.txt')
  assert.equal(entries[0].type, TAR_TYPE.FILE)
  assert.equal(entries[0].size, Buffer.byteLength(content, 'utf8'))
  assert.equal(entries[0].data.toString('utf8'), content)
  // 负对照：不写结束标记（两个零块）→ 有些解包器会报「意外的 EOF」
})

test('buildTar：目录条目的 size 必须是 0', () => {
  const tar = buildTar({ name: 'adir/', type: TAR_TYPE.DIRECTORY })
  const entries = parseTar(tar)
  assert.equal(entries[0].type, TAR_TYPE.DIRECTORY)
  assert.equal(entries[0].size, 0)
  assert.equal(entries[0].mode, 0o755, '目录默认权限应当是 755')
  // 负对照：目录也写 data 长度 → 解包器会把后面的块当成数据
})

test('buildTar：校验和必须正确（否则 tar 命令拒绝解包）', () => {
  const tar = buildTar({ name: 'x.txt', content: 'abc' })
  const header = tar.subarray(0, 512)
  const recorded = Number.parseInt(header.subarray(148, 156).toString('utf8').replace(/\0/g, '').trim(), 8)

  // 自己重算一遍：校验和字段按 8 个空格算
  const copy = Buffer.from(header)
  copy.write('        ', 148, 8, 'utf8')
  let sum = 0
  for (const byte of copy) sum += byte

  assert.equal(recorded, sum, '校验和字段必须与内容一致')
  // 负对照：校验和写错 → 真实 tar/docker 会拒绝这个包
})

test('buildTar：二进制内容按字节保留（不被 UTF-8 破坏）', () => {
  const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x0a])
  const tar = buildTar({ name: 'bin.dat', content: bytes })
  const entry = extractSingleEntry(tar, '/anywhere/bin.dat')
  assert.ok(entry.data.equals(bytes))
  // 负对照：把内容当字符串处理 → NUL 与 0xff 会被改坏
})

test('buildTar：数据按 512 字节对齐', () => {
  const tar = buildTar({ name: 'a.txt', content: 'x' })
  // 头 512 + 数据对齐 512 + 结束 1024
  assert.equal(tar.length, 512 + 512 + 1024)
  // 负对照：不对齐 → 下一个块的头会错位，解析直接崩
})

test('buildTar：长路径拆到 ustar prefix 字段', () => {
  const longName = `${'a'.repeat(90)}/${'b'.repeat(90)}/file.txt`
  const tar = buildTar({ name: longName, content: 'deep\n' })
  const entries = parseTar(tar)
  assert.equal(entries[0].name, longName, 'name + prefix 拼回来必须等于原路径')
  // 负对照：只写 name 字段（100 字节上限）→ 长路径被截断或抛错
})

test('buildTar：放不下的超长路径要明确报错，而不是截断', () => {
  const tooLong = `${'a'.repeat(200)}/${'b'.repeat(200)}/x`
  assert.throws(() => buildTar({ name: tooLong, content: 'x' }), /路径太长/)
  // 负对照：静默截断 → 文件被写到错误的路径
})

test('buildTar：符号链接记录 linkTarget', () => {
  const tar = buildTar({ name: 'link.txt', type: TAR_TYPE.SYMLINK, linkTarget: 'real.txt' })
  const entries = parseTar(tar)
  assert.equal(entries[0].type, TAR_TYPE.SYMLINK)
  assert.equal(entries[0].linkTarget, 'real.txt')
  assert.equal(entries[0].size, 0)
  // 负对照：不写 typeflag → 会被当成 0 字节的普通文件
})

test('parseTar：多个条目依次解析', () => {
  const a = buildTar({ name: 'a.txt', content: 'AAA' })
  const b = buildTar({ name: 'b.txt', content: 'BBB' })
  // 把 a 的结束标记去掉再接上 b，模拟真实的多条目 tar
  const combined = Buffer.concat([a.subarray(0, 512 * 2), b])
  const entries = parseTar(combined)
  assert.deepEqual(entries.map((entry) => entry.name), ['a.txt', 'b.txt'])
  assert.equal(entries[1].data.toString('utf8'), 'BBB')
  // 负对照：解析完第一条就停 → 只拿到 a
})

test('parseTar：数据被截断时明确报错', () => {
  const tar = buildTar({ name: 'a.txt', content: 'x'.repeat(1000) })
  const truncated = tar.subarray(0, 512 + 100) // 头 + 部分数据
  assert.throws(() => parseTar(truncated), /截断/)
  // 负对照：不检查长度 → 返回一个短了的数据，上层以为读全了
})

test('parseTar：空缓冲区返回空数组（不崩）', () => {
  assert.deepEqual(parseTar(Buffer.alloc(0)), [])
  assert.deepEqual(parseTar(Buffer.alloc(1024)), [], '全零块 = 结束')
  // 负对照：不判空 → 读头部时越界
})

test('extractSingleEntry：按 basename 挑出目标条目', () => {
  const tar = buildTar({ name: 'wanted.txt', content: 'yes\n' })
  const entry = extractSingleEntry(tar, '/some/deep/path/wanted.txt')
  assert.equal(entry.data.toString('utf8'), 'yes\n')
  // 负对照：不按名字挑、直接取第一条 → 目录场景会拿错文件
})

test('extractSingleEntry：空 archive 明确报错', () => {
  assert.throws(() => extractSingleEntry(Buffer.alloc(0), '/x'), /空的 archive/)
  // 负对照：返回 undefined → 上层在别处崩，错误指不到根因
})

test('extractSingleEntry：base-256 编码的数字要明确拒绝，而不是算错', () => {
  // 造一个首字节高位为 1 的 size 字段（GNU 的大数编码）
  const tar = Buffer.from(buildTar({ name: 'a.txt', content: 'x' }))
  tar[124] = 0x80
  assert.throws(() => parseTar(tar), /base-256/)
  // 负对照：按八进制硬解 → 得到一个完全错误的大小，然后越界读
})
