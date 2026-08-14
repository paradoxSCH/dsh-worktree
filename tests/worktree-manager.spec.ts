import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorktreeManager } from '../src/index.js'

const execFileAsync = promisify(execFile)
const cleanup: Array<() => Promise<void>> = []

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return stdout.trim()
}

async function repositoryFixture(): Promise<{ root: string; repository: string; managedRoot: string; journalPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-test-'))
  const repository = join(root, 'repository')
  const managedRoot = join(root, 'managed')
  const journalPath = join(root, 'state', 'operations.jsonl')
  await execFileAsync('git', ['init', repository])
  await git(repository, 'config', 'core.autocrlf', 'false')
  await git(repository, 'config', 'user.name', 'dsh-worktree test')
  await git(repository, 'config', 'user.email', 'dsh-worktree@example.invalid')
  await writeFile(join(repository, 'README.md'), 'base\n', 'utf8')
  await git(repository, 'add', 'README.md')
  await git(repository, 'commit', '-m', 'base')
  return { root, repository, managedRoot, journalPath }
}

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

describe('WorktreeManager', () => {
  it('creates a durable isolated worktree from committed HEAD and removes it when clean', async () => {
    const fixture = await repositoryFixture()
    cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
    const manager = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
    })
    cleanup.push(() => manager.close())

    const created = await manager.create({
      repository: fixture.repository,
      source: { kind: 'head' },
      lifetime: 'ephemeral',
    })

    expect(created.state).toBe('ready')
    expect(created.path).not.toBe(fixture.repository)
    expect(created.baseCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(await readFile(join(created.path, 'README.md'), 'utf8')).toBe('base\n')
    expect(await git(created.path, 'rev-parse', 'HEAD')).toBe(created.baseCommit)
    expect(await readFile(fixture.journalPath, 'utf8')).toContain('"kind":"worktree_ready"')

    const inspected = await manager.inspect(created.id)
    expect(inspected.changes.dirty).toBe(false)
    expect(inspected.changes.newCommitCount).toBe(0)

    await manager.conclude({ id: created.id, action: 'remove-clean' })
    expect((await manager.list()).find((item) => item.id === created.id)?.state).toBe('removed')
  })

  it('reconstructs staged, unstaged, and untracked parent state without copying ignored files', async () => {
    const fixture = await repositoryFixture()
    cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
    const manager = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
    })
    cleanup.push(() => manager.close())

    await writeFile(join(fixture.repository, '.gitignore'), '.env\n', 'utf8')
    await git(fixture.repository, 'add', '.gitignore')
    await git(fixture.repository, 'commit', '-m', 'ignore local environment')
    await writeFile(join(fixture.repository, 'README.md'), 'staged\n', 'utf8')
    await git(fixture.repository, 'add', 'README.md')
    await writeFile(join(fixture.repository, 'README.md'), 'staged\nunstaged\n', 'utf8')
    await writeFile(join(fixture.repository, 'notes.txt'), 'untracked\n', 'utf8')
    await writeFile(join(fixture.repository, '.env'), 'SECRET=not-copied\n', 'utf8')

    const created = await manager.create({
      repository: fixture.repository,
      source: { kind: 'working-state', includeIgnored: 'allowlist' },
      lifetime: 'managed',
    })

    expect(await readFile(join(created.path, 'README.md'), 'utf8')).toBe('staged\nunstaged\n')
    expect(await readFile(join(created.path, 'notes.txt'), 'utf8')).toBe('untracked\n')
    await expect(readFile(join(created.path, '.env'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(created.changes).toMatchObject({
      dirty: true,
      stagedFileCount: 1,
      unstagedFileCount: 1,
      untrackedFileCount: 1,
      newCommitCount: 0,
    })
    expect(created.changedFromInitial).toBe(false)
    expect(await git(created.path, 'diff', '--cached', '--name-only')).toBe('README.md')
    expect(await git(created.path, 'diff', '--name-only')).toBe('README.md')

    await manager.conclude({ id: created.id, action: 'remove-clean' })
  })

  it('retains agent changes unless discard uses a fresh inspection token', async () => {
    const fixture = await repositoryFixture()
    cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
    const manager = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
    })
    cleanup.push(() => manager.close())

    const created = await manager.create({
      repository: fixture.repository,
      source: { kind: 'head' },
      lifetime: 'managed',
    })
    await writeFile(join(created.path, 'agent.txt'), 'first result\n', 'utf8')

    const firstInspection = await manager.inspect(created.id)
    expect(firstInspection.changedFromInitial).toBe(true)
    await expect(manager.conclude({ id: created.id, action: 'remove-clean' }))
      .rejects.toMatchObject({ code: 'WORKTREE_CHANGED' })

    await writeFile(join(created.path, 'agent.txt'), 'second result\n', 'utf8')
    await expect(manager.conclude({
      id: created.id,
      action: 'discard',
      changeToken: firstInspection.changeToken,
      confirmation: 'discard',
    })).rejects.toMatchObject({ code: 'WORKTREE_CHANGE_TOKEN_STALE' })

    const freshInspection = await manager.inspect(created.id)
    const removed = await manager.conclude({
      id: created.id,
      action: 'discard',
      changeToken: freshInspection.changeToken,
      confirmation: 'discard',
    })
    expect(removed.state).toBe('removed')
  })

  it('creates a fresh worktree from an explicitly fetched remote ref', async () => {
    const fixture = await repositoryFixture()
    cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
    const remote = join(fixture.root, 'origin.git')
    const publisher = join(fixture.root, 'publisher')
    await execFileAsync('git', ['clone', '--bare', fixture.repository, remote])
    await execFileAsync('git', ['clone', remote, publisher])
    await git(publisher, 'config', 'user.name', 'dsh-worktree test')
    await git(publisher, 'config', 'user.email', 'dsh-worktree@example.invalid')
    const branch = await git(publisher, 'branch', '--show-current')
    await writeFile(join(publisher, 'remote.txt'), 'remote state\n', 'utf8')
    await git(publisher, 'add', 'remote.txt')
    await git(publisher, 'commit', '-m', 'remote update')
    await git(publisher, 'push', 'origin', branch)
    await git(fixture.repository, 'remote', 'add', 'origin', remote)

    const manager = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
    })
    cleanup.push(() => manager.close())
    const created = await manager.create({
      repository: fixture.repository,
      source: { kind: 'fresh', remote: 'origin', ref: branch },
      lifetime: 'managed',
    })

    expect(await readFile(join(created.path, 'remote.txt'), 'utf8')).toBe('remote state\n')
    expect(created.baseCommit).toBe(await git(publisher, 'rev-parse', 'HEAD'))
    expect(created.changedFromInitial).toBe(false)
    await manager.conclude({ id: created.id, action: 'remove-clean' })
  }, 15_000)

  it('recovers a worktree after a crash at the post-add durability boundary', async () => {
    const fixture = await repositoryFixture()
    cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
    let crashed = false
    const interrupted = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
      onBoundary: async (boundary) => {
        if (!crashed && boundary === 'after-worktree-added') {
          crashed = true
          throw new Error('simulated process crash')
        }
      },
    })

    await expect(interrupted.create({
      repository: fixture.repository,
      source: { kind: 'head' },
      lifetime: 'managed',
    })).rejects.toThrow('simulated process crash')
    await interrupted.close()

    const reopened = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
    })
    cleanup.push(() => reopened.close())
    const report = await reopened.recover()
    expect(report.recovered).toHaveLength(1)
    expect(report.manual).toHaveLength(0)
    const [recovered] = await reopened.list()
    expect(recovered?.state).toBe('ready')
    await reopened.conclude({ id: recovered!.id, action: 'remove-clean' })
  })
})
