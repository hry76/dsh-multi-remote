/**
 * `src/mirror/git.js` 的契约测试。
 *
 * 这一层唯一的存在理由：**锚点目录必须是 git 仓库，宿主的改动对比才看得到东西**。
 * 所以测试的重点不是「git 命令跑通了」，而是「镜像的更新会表现为未提交的改动」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ensureAnchorRepo,
  commitBaseline,
  readAnchorChanges,
  isGitRepo,
  runGit,
  ANCHOR_GITIGNORE_CONTENT,
} from '../src/mirror/git.js'

/** 建一个临时目录，测试结束自动清理。 */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mirror-git-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('ensureAnchorRepo：建目录、init、写 .gitignore，且幂等', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')

    const first = await ensureAnchorRepo(anchor)
    assert.equal(first.created, true, '首次应真的建了仓库')
    assert.equal(first.gitignoreWritten, true, '首次应写了 .gitignore')
    assert.equal(await isGitRepo(anchor), true)

    const ignoreText = await readFile(join(anchor, '.gitignore'), 'utf8')
    assert.equal(ignoreText, ANCHOR_GITIGNORE_CONTENT)
    assert.ok(ignoreText.includes('.dsh-multi-remote/'), '镜像状态目录必须被忽略')

    // 幂等：再来一次不能重复 init，也不能覆盖用户可能改过的 .gitignore
    await writeFile(join(anchor, '.gitignore'), '# 用户改过了\n', 'utf8')
    const second = await ensureAnchorRepo(anchor)
    assert.equal(second.created, false, '已存在时不应重复 init')
    assert.equal(second.gitignoreWritten, false, '已存在时不应覆盖 .gitignore')
    assert.equal(await readFile(join(anchor, '.gitignore'), 'utf8'), '# 用户改过了\n')
    // 负对照：去掉 isGitRepo 判断，second.created 会变成 true
  })
})

test('commitBaseline + 后续镜像更新 = 改动对比看得到的差异', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    await ensureAnchorRepo(anchor)

    // 模拟「格局层」第一次拉下来的远程内容
    await mkdir(join(anchor, 'src'), { recursive: true })
    await writeFile(join(anchor, 'README.md'), '# 远程项目\n', 'utf8')
    await writeFile(join(anchor, 'src', 'app.js'), 'export const v = 1\n', 'utf8')

    const committed = await commitBaseline(anchor, 'chore(mirror): 初始镜像基线')
    assert.equal(committed.committed, true)
    assert.ok(committed.commit, '应返回 commit id')

    // 基线之后：镜像更新（agent 在远程改了文件 → 照片层顺手写回）
    await writeFile(join(anchor, 'src', 'app.js'), 'export const v = 2\n', 'utf8')
    await writeFile(join(anchor, 'src', 'added.js'), 'export const added = true\n', 'utf8')

    const changes = await readAnchorChanges(anchor)
    assert.equal(changes.isRepo, true)
    assert.match(changes.porcelain, /M src\/app\.js/, '被改的文件应出现在 status 里')
    assert.match(changes.porcelain, /\?\? src\/added\.js/, '新增文件应出现在 status 里')
    assert.match(changes.numstat, /1\t1\tsrc\/app\.js/, 'numstat 应给出真实增删行数')
    // 负对照：若 commitBaseline 之后又自动提交一次，porcelain 会变空 → 这三条断言全红
  })
})

test('没有基线提交时，改动对比拿不到 HEAD 比较（allowExitCodes 兜住）', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    await ensureAnchorRepo(anchor)
    await writeFile(join(anchor, 'a.txt'), 'hello\n', 'utf8')

    // 仓库存在但没有任何提交：`git diff HEAD` 会以 128 失败。
    // readAnchorChanges 必须容忍这种情况（首次镜像还没提交时就是这样）。
    const changes = await readAnchorChanges(anchor)
    assert.equal(changes.isRepo, true)
    assert.equal(changes.numstat, '', '没有 HEAD 时 numstat 应为空而不是抛错')
    assert.match(changes.porcelain, /\?\? a\.txt/)
    // 负对照：去掉 allowExitCodes:[0,128]，这里会抛 GitError
  })
})

test('锚点不是仓库时 readAnchorChanges 明确报告，不抛错', async () => {
  await withTempDir(async (dir) => {
    const changes = await readAnchorChanges(dir)
    assert.deepEqual(changes, { porcelain: '', numstat: '', isRepo: false })
    // 负对照：去掉 isGitRepo 短路，`git status` 会以 128 失败并抛 GitError
  })
})

test('commitBaseline 在没有变化时不做空提交', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    await ensureAnchorRepo(anchor)
    await writeFile(join(anchor, 'a.txt'), 'x\n', 'utf8')
    const first = await commitBaseline(anchor, 'first')
    assert.equal(first.committed, true)

    const second = await commitBaseline(anchor, 'second')
    assert.equal(second.committed, false)
    assert.equal(second.reason, 'nothing-to-commit')

    const count = await runGit(['rev-list', '--count', 'HEAD'], { cwd: anchor })
    assert.equal(count.stdout.trim(), '1', '不应产生第二个提交')
    // 负对照：去掉「暂存区为空就返回」的短路，会多出一个空提交 → count 变成 2
  })
})

test('镜像状态目录被 .gitignore 排除，不污染改动对比', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    await ensureAnchorRepo(anchor)
    await writeFile(join(anchor, 'a.txt'), 'x\n', 'utf8')
    await commitBaseline(anchor, 'baseline')

    // 镜像自己的状态（记录上次刷新时间、远程路径等）不应出现在改动对比里
    await mkdir(join(anchor, '.dsh-multi-remote'), { recursive: true })
    await writeFile(join(anchor, '.dsh-multi-remote', 'state.json'), '{}\n', 'utf8')

    const changes = await readAnchorChanges(anchor)
    assert.equal(changes.porcelain, '', `状态文件不该出现在改动里，实际：${changes.porcelain}`)
    // 负对照：从 ANCHOR_GITIGNORE_CONTENT 里删掉 `.dsh-multi-remote/`，这里会变成 `?? .dsh-multi-remote/`
  })
})

test('commitBaseline 不依赖用户是否配过 git user.name', async () => {
  await withTempDir(async (dir) => {
    const anchor = join(dir, 'anchor')
    await ensureAnchorRepo(anchor)
    await writeFile(join(anchor, 'a.txt'), 'x\n', 'utf8')

    // 真正的隔离：把全局与系统 git 配置都指向空文件。
    // 只改 HOME/USERPROFILE 是不够的 —— Windows 上 git 还会读 %PROGRAMDATA%\Git\config，
    // 而多数开发机的全局配置里本来就有 user.name，那样这条测试会因为「碰巧有身份」而通过，
    // 变成一条永远绿的摆设（第一版就是这么写的，做变异测试时被抓出来了）。
    const saved = {}
    const overrides = {
      HOME: dir,
      USERPROFILE: dir,
      XDG_CONFIG_HOME: join(dir, 'xdg'),
      GIT_CONFIG_GLOBAL: join(dir, 'no-global-config'),
      GIT_CONFIG_SYSTEM: join(dir, 'no-system-config'),
      GIT_CONFIG_NOSYSTEM: '1',
    }
    for (const [key, value] of Object.entries(overrides)) {
      saved[key] = process.env[key]
      process.env[key] = value
    }

    try {
      // 先证明隔离真的生效：此时 git 应当查不到任何身份
      const probe = await runGit(['config', '--get', 'user.name'], {
        cwd: anchor,
        allowExitCodes: [0, 1],
      })
      assert.equal(probe.stdout.trim(), '', '前置条件：隔离后不应存在全局 git 身份')

      const result = await commitBaseline(anchor, 'baseline')
      assert.equal(result.committed, true, '缺全局身份时也必须能提交')
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    // 负对照：把 runGit 里的 GIT_AUTHOR_NAME/EMAIL 去掉，会因「Author identity unknown」失败
  })
})
