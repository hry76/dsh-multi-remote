/**
 * `src/session/profile.js` 的持久化部分测试。
 *
 * 核心承诺：**凭据绝不落盘、绝不回显**。
 * 这不是「注意一下」就能保证的事，所以把它变成机器判据：
 * 存完之后直接读原始文件字节，逐字检查有没有敏感值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  saveProfile,
  loadProfile,
  listProfiles,
  deleteProfile,
  persistableProfile,
  NON_PERSISTED_KEYS,
} from '../src/session/profile.js'

const SECRET_PASSWORD = 'hunter2-super-secret'
const SECRET_KEY_BODY = '-----BEGIN OPENSSH PRIVATE KEY-----SUPERSECRETBODY-----END-----'
const SECRET_PASSPHRASE = 'key-passphrase-secret'

/** 一份「什么都配了」的档案。 */
const fullProfile = {
  id: 'conn-1',
  label: '测试机',
  host: 'example.invalid',
  port: 22,
  username: 'user',
  privateKeyPath: 'C:\\Users\\\\user\\\\.ssh\\id_ed25519',
  privateKey: SECRET_KEY_BODY,
  passphrase: SECRET_PASSPHRASE,
  password: SECRET_PASSWORD,
  agent: 'C:\\sock\\agent.sock',
  tryKeyboard: true,
  remoteRoot: '/home/user/proj',
  anchorParent: 'D:\\anchors',
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'profile-store-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('persistableProfile：剥掉全部敏感字段，保留非敏感字段', () => {
  const safe = persistableProfile(fullProfile)
  for (const key of NON_PERSISTED_KEYS) {
    assert.equal(safe[key], undefined, `${key} 不该出现在可落盘对象里`)
  }
  assert.equal(safe.host, 'example.invalid')
  assert.equal(safe.remoteRoot, '/home/user/proj')
  assert.equal(safe.privateKeyPath, 'C:\\Users\\\\user\\\\.ssh\\id_ed25519', '私钥**路径**可以留（不是凭据本身）')
  // 负对照：不剥 password/privateKey，下面的磁盘检查会抓到明文
})

test('saveProfile：磁盘上的字节里没有口令、私钥内容或口令短语', async () => {
  await withTempDir(async (dir) => {
    const result = await saveProfile(dir, fullProfile)
    const raw = await readFile(result.path, 'utf8')

    assert.ok(!raw.includes(SECRET_PASSWORD), '磁盘文件里出现了登录口令')
    assert.ok(!raw.includes(SECRET_KEY_BODY), '磁盘文件里出现了私钥内容')
    assert.ok(!raw.includes(SECRET_PASSPHRASE), '磁盘文件里出现了私钥口令短语')
    assert.ok(!raw.includes('agent.sock'), '磁盘文件里出现了 agent socket')

    // 非敏感字段确实存下来了（否则「保存」没意义）
    assert.ok(raw.includes('example.invalid'))
    assert.ok(raw.includes('/home/user/proj'))

    assert.deepEqual(result.stripped.sort(), [...NON_PERSISTED_KEYS].sort())
    // 负对照：把 persistableProfile 换成直接 JSON.stringify(profile)，三条断言全红
  })
})

test('saveProfile：文件权限尽力设为 0600', async () => {
  await withTempDir(async (dir) => {
    const result = await saveProfile(dir, fullProfile)
    const info = await stat(result.path)
    if (process.platform === 'win32') {
      // Windows 上 POSIX 权限位不生效，只断言文件确实建出来了
      assert.ok(info.isFile())
    } else {
      assert.equal(info.mode & 0o777, 0o600, '凭据相关文件必须是 0600')
    }
    // 负对照：不传 mode 也不 chmod，POSIX 上会得到 0644
  })
})

test('saveProfile 幂等：同一档案重复保存不报错', async () => {
  await withTempDir(async (dir) => {
    await saveProfile(dir, fullProfile)
    await saveProfile(dir, { ...fullProfile, label: '改了名字' })
    const loaded = await loadProfile(dir, 'conn-1')
    assert.equal(loaded.label, '改了名字')
    // 负对照：用 'wx' 标志写文件，第二次会 EEXIST
  })
})

test('loadProfile：读回可再次用于连接（敏感字段为空，由调用方现给）', async () => {
  await withTempDir(async (dir) => {
    await saveProfile(dir, fullProfile)
    const loaded = await loadProfile(dir, 'conn-1')

    assert.equal(loaded.host, 'example.invalid')
    assert.equal(loaded.username, 'user')
    assert.equal(loaded.password, undefined, '口令必须为空 —— 每次连接现给')
    assert.equal(loaded.privateKey, undefined)
    assert.equal(loaded.privateKeyPath, fullProfile.privateKeyPath, '路径在，所以重连不用重敲')
    // 负对照：把敏感字段也存了，重连时就会用到一份可能过期的旧口令
  })
})

test('loadProfile：不存在或坏 JSON 都返回 undefined，不抛错', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await loadProfile(dir, 'nope'), undefined)

    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8')
    assert.equal(await loadProfile(dir, 'broken'), undefined)
    // 负对照：不 catch，一个坏文件会把「列出/连接」整个流程打挂
  })
})

test('listProfiles：排序稳定，坏文件被跳过，且不回传敏感字段', async () => {
  await withTempDir(async (dir) => {
    await saveProfile(dir, { ...fullProfile, id: 'b-conn' })
    await saveProfile(dir, { ...fullProfile, id: 'a-conn' })
    await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8')
    await writeFile(join(dir, 'notes.txt'), '不是 json', 'utf8')

    const list = await listProfiles(dir)
    assert.deepEqual(list.map((entry) => entry.id), ['a-conn', 'b-conn'])

    // 即使有人手工往文件里塞了口令，列表也不能把它回出去
    await writeFile(
      join(dir, 'sneaky.json'),
      JSON.stringify({ id: 'sneaky', host: 'h', password: SECRET_PASSWORD }),
      'utf8',
    )
    const after = await listProfiles(dir)
    const sneaky = after.find((entry) => entry.id === 'sneaky')
    assert.equal(sneaky.password, undefined, '列表必须剥掉敏感字段')
    // 负对照：直接返回 JSON.parse 的结果，口令会被回给调用方（进而可能进工具输出）
  })
})

test('listProfiles：目录不存在时返回空数组', async () => {
  assert.deepEqual(await listProfiles(join(tmpdir(), 'definitely-not-here-xyz')), [])
  // 负对照：不 catch ENOENT，第一次使用（还没建目录）就会崩
})

test('deleteProfile：删掉返回 true，再删返回 false', async () => {
  await withTempDir(async (dir) => {
    await saveProfile(dir, fullProfile)
    assert.equal(await deleteProfile(dir, 'conn-1'), true)
    assert.equal(await deleteProfile(dir, 'conn-1'), false)
    assert.equal(await loadProfile(dir, 'conn-1'), undefined)
    // 负对照：删不存在的不 catch，会抛 ENOENT
  })
})
