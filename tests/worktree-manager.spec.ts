import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorktreeManager } from '../src/index.js'

const execFileAsync = promisify(execFile)
const cleanup: Array<() => Promise<void>> = []

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return stdout.trim()
}

async function repositoryFixture(): Promise<{ root: string; repository: string; managedRoot: string; journalPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-test-'))
  const requestedRepository = join(root, 'repository')
  const managedRoot = join(root, 'managed')
  const journalPath = join(root, 'state', 'operations.jsonl')
  await execFileAsync('git', ['init', requestedRepository])
  // Git reports canonical paths. Resolve the fixture too so assertions remain
  // stable across macOS /var -> /private/var and Windows 8.3 path aliases.
  const repository = await realpath(requestedRepository)
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
  it('runs independent repositories concurrently while preserving per-worktree ordering', async () => {
    const first = await repositoryFixture()
    const second = await repositoryFixture()
    cleanup.push(() => rm(first.root, { recursive: true, force: true }))
    cleanup.push(() => rm(second.root, { recursive: true, force: true }))
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstId: string | undefined
    let signalFirst!: () => void
    const firstReachedBoundary = new Promise<void>((resolve) => { signalFirst = resolve })
    const manager = createWorktreeManager({
      managedRoot: first.managedRoot,
      journalPath: first.journalPath,
      async onBoundary(boundary, id) {
        if (boundary !== 'after-create-planned') return
        if (firstId === undefined) {
          firstId = id
          signalFirst()
          await firstGate
        }
      },
    })
    cleanup.push(() => manager.close())

    const firstCreate = manager.create({ repository: first.repository, source: { kind: 'head' }, lifetime: 'managed' })
    await firstReachedBoundary
    const secondCreated = await manager.create({ repository: second.repository, source: { kind: 'head' }, lifetime: 'managed' })
    releaseFirst()
    await firstCreate
    expect(secondCreated.repository).toBe(second.repository)
  }, 15_000)

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

  it('copies only allowlisted ignored files and requires an explicit sensitive-file override', async () => {
    const fixture = await repositoryFixture()
    cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
    const manager = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
    })
    cleanup.push(() => manager.close())
    await writeFile(join(fixture.repository, '.gitignore'), '.cache/\n.env\n', 'utf8')
    await writeFile(join(fixture.repository, '.worktreeinclude'), '.cache/**\n', 'utf8')
    await git(fixture.repository, 'add', '.gitignore', '.worktreeinclude')
    await git(fixture.repository, 'commit', '-m', 'configure worktree include')
    await mkdir(join(fixture.repository, '.cache'))
    await writeFile(join(fixture.repository, '.cache', 'settings.json'), '{"safe":true}\n', 'utf8')
    await writeFile(join(fixture.repository, '.env'), 'SECRET=blocked\n', 'utf8')

    const included = await manager.create({
      repository: fixture.repository,
      source: { kind: 'working-state', includeIgnored: 'allowlist' },
      lifetime: 'managed',
    })
    expect(await readFile(join(included.path, '.cache', 'settings.json'), 'utf8')).toBe('{"safe":true}\n')
    await expect(readFile(join(included.path, '.env'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(included.changedFromInitial).toBe(false)

    await writeFile(join(fixture.repository, '.worktreeinclude'), '.cache/**\n.env\n', 'utf8')
    await expect(manager.create({
      repository: fixture.repository,
      source: { kind: 'working-state', includeIgnored: 'allowlist' },
      lifetime: 'managed',
    })).rejects.toMatchObject({ code: 'WORKTREE_SNAPSHOT_SENSITIVE_IGNORED' })
    const allowed = await manager.create({
      repository: fixture.repository,
      source: { kind: 'working-state', includeIgnored: 'allowlist', allowSensitiveIgnored: true },
      lifetime: 'managed',
    })
    expect(await readFile(join(allowed.path, '.env'), 'utf8')).toBe('SECRET=blocked\n')
    expect(allowed.changedFromInitial).toBe(false)
  }, 15_000)

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

  it('persists owner leases and blocks cleanup until every consumer releases', async () => {
    const fixture = await repositoryFixture()
    cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
    const manager = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
    })
    const created = await manager.create({
      repository: fixture.repository,
      source: { kind: 'head' },
      lifetime: 'managed',
    })
    const lease = await manager.acquireLease(created.id, {
      kind: 'session',
      id: 'session-1',
      label: 'review conversation',
    })
    await manager.close()

    const reopened = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
    })
    cleanup.push(() => reopened.close())
    expect((await reopened.inspect(created.id)).activeLeases).toEqual([lease])
    await expect(reopened.conclude({ id: created.id, action: 'remove-clean' }))
      .rejects.toMatchObject({ code: 'WORKTREE_IN_USE' })

    await reopened.releaseLease(created.id, lease.id)
    expect((await reopened.inspect(created.id)).activeLeases).toHaveLength(0)
    await expect(reopened.conclude({ id: created.id, action: 'remove-clean' }))
      .resolves.toMatchObject({ state: 'removed' })
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

  it.each(['after-unlock-for-removal', 'after-worktree-removed'] as const)(
    'finishes a planned removal after a crash at %s',
    async (crashBoundary) => {
      const fixture = await repositoryFixture()
      cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
      let crashed = false
      const interrupted = createWorktreeManager({
        managedRoot: fixture.managedRoot,
        journalPath: fixture.journalPath,
        onBoundary: async (boundary) => {
          if (!crashed && boundary === crashBoundary) {
            crashed = true
            throw new Error(`simulated crash at ${boundary}`)
          }
        },
      })
      const created = await interrupted.create({
        repository: fixture.repository,
        source: { kind: 'head' },
        lifetime: 'managed',
      })
      await expect(interrupted.conclude({ id: created.id, action: 'remove-clean' }))
        .rejects.toThrow(`simulated crash at ${crashBoundary}`)
      await interrupted.close()

      const reopened = createWorktreeManager({
        managedRoot: fixture.managedRoot,
        journalPath: fixture.journalPath,
      })
      cleanup.push(() => reopened.close())
      const report = await reopened.recover()
      expect(report.recovered).toEqual([created.id])
      expect(report.manual).toHaveLength(0)
      expect((await reopened.inspect(created.id)).state).toBe('removed')
    },
  )

  it('archives a changed worktree to durable Git and snapshot artifacts and restores it exactly', async () => {
    const fixture = await repositoryFixture()
    cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
    const manager = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
    })
    const created = await manager.create({
      repository: fixture.repository,
      source: { kind: 'head' },
      lifetime: 'managed',
    })
    await writeFile(join(created.path, 'committed.txt'), 'durable commit\n', 'utf8')
    await git(created.path, 'add', 'committed.txt')
    await git(created.path, 'commit', '-m', 'agent commit')
    await writeFile(join(created.path, 'README.md'), 'staged archive\n', 'utf8')
    await git(created.path, 'add', 'README.md')
    await writeFile(join(created.path, 'README.md'), 'staged archive\nworking archive\n', 'utf8')
    await writeFile(join(created.path, 'untracked.txt'), 'untracked archive\n', 'utf8')

    const before = await manager.inspect(created.id)
    const archived = await manager.act({ id: created.id, action: 'archive', changeToken: before.changeToken })
    expect(archived.state).toBe('archived')
    await expect(readFile(join(created.path, 'README.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(fixture.repository, 'rev-parse', `refs/dsh-worktree/archive/${created.id}`)).toBe(before.headCommit)
    await manager.close()

    const reopened = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
    })
    cleanup.push(() => reopened.close())
    const restored = await reopened.act({ id: created.id, action: 'restore' })
    expect(restored.state).toBe('ready')
    expect(restored.headCommit).toBe(before.headCommit)
    expect(await readFile(join(created.path, 'committed.txt'), 'utf8')).toBe('durable commit\n')
    expect(await readFile(join(created.path, 'README.md'), 'utf8')).toBe('staged archive\nworking archive\n')
    expect(await readFile(join(created.path, 'untracked.txt'), 'utf8')).toBe('untracked archive\n')
    expect(await git(created.path, 'diff', '--cached', '--name-only')).toBe('README.md')
    expect(await git(created.path, 'diff', '--name-only')).toBe('README.md')
  }, 15_000)

  it('produces stable review projections and persists validation summaries', async () => {
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
    await writeFile(join(created.path, 'README.md'), 'reviewed change\n', 'utf8')
    await writeFile(join(created.path, 'untracked.txt'), 'new file\n', 'utf8')

    const review = await manager.review(created.id)
    expect(review.diff).toContain('reviewed change')
    expect(review.untrackedPaths).toEqual(['untracked.txt'])
    expect(review.truncated).toBe(false)
    const validation = await manager.validate(created.id, [{
      name: 'verify cwd and file',
      executable: process.execPath,
      args: ['-e', "const fs=require('fs');if(!fs.existsSync('README.md'))process.exit(7);console.log(process.cwd())"],
      timeoutMs: 10_000,
    }])
    expect(validation.passed).toBe(true)
    expect(validation.results[0]?.stdout).toContain(created.path)
    expect((await manager.inspect(created.id)).lastValidation).toEqual({
      id: validation.id,
      passed: true,
      completedAt: validation.completedAt,
      commands: validation.commands,
    })
  })

  it('materializes a detached result as a durable branch and recovers after attachment', async () => {
    const fixture = await repositoryFixture()
    cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
    let crashed = false
    const interrupted = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
      onBoundary: async (boundary) => {
        if (!crashed && boundary === 'after-branch-attached') {
          crashed = true
          throw new Error('simulated branch attachment crash')
        }
      },
    })
    const created = await interrupted.create({
      repository: fixture.repository,
      source: { kind: 'head' },
      lifetime: 'managed',
    })
    const before = await interrupted.inspect(created.id)
    expect(before.branch).toBeNull()
    await expect(interrupted.act({
      id: created.id,
      action: 'create-branch',
      name: 'dsh/feature-one',
      changeToken: before.changeToken,
    })).rejects.toThrow('simulated branch attachment crash')
    await interrupted.close()

    const reopened = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
    })
    cleanup.push(() => reopened.close())
    const report = await reopened.recover()
    expect(report.recovered).toContain(created.id)
    const recovered = await reopened.inspect(created.id)
    expect(recovered.branch).toBe('dsh/feature-one')
    expect(await git(created.path, 'rev-parse', 'refs/heads/dsh/feature-one')).toBe(created.headCommit)
  })

  it.each(['after-commit-staged', 'after-commit-created'] as const)(
    'commits all working changes once and recovers from %s',
    async (crashBoundary) => {
    const fixture = await repositoryFixture()
    cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
    let crashed = false
    const interrupted = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
      onBoundary: async (boundary) => {
        if (!crashed && boundary === crashBoundary) {
          crashed = true
          throw new Error('simulated commit crash')
        }
      },
    })
    const created = await interrupted.create({ repository: fixture.repository, source: { kind: 'head' }, lifetime: 'managed' })
    await writeFile(join(created.path, 'README.md'), 'committed by product\n', 'utf8')
    await writeFile(join(created.path, 'new.txt'), 'new\n', 'utf8')
    const before = await interrupted.inspect(created.id)
    await expect(interrupted.act({
      id: created.id,
      action: 'commit',
      message: 'complete agent result',
      changeToken: before.changeToken,
    })).rejects.toThrow('simulated commit crash')
    await interrupted.close()

    const reopened = createWorktreeManager({ managedRoot: fixture.managedRoot, journalPath: fixture.journalPath })
    cleanup.push(() => reopened.close())
    expect((await reopened.recover()).recovered).toContain(created.id)
    const recovered = await reopened.inspect(created.id)
    expect(recovered.changes.dirty).toBe(false)
    expect(recovered.changes.newCommitCount).toBe(1)
    expect(recovered.lastDelivery?.kind).toBe('commit')
    expect(await git(created.path, 'log', '-1', '--format=%s')).toBe('complete agent result')
    },
  )

  it('hands off commits and working changes to a clean target and recovers after apply', async () => {
    const fixture = await repositoryFixture()
    cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
    let crashed = false
    const interrupted = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
      onBoundary: async (boundary) => {
        if (!crashed && boundary === 'after-handoff-applied') {
          crashed = true
          throw new Error('simulated handoff crash')
        }
      },
    })
    const created = await interrupted.create({
      repository: fixture.repository,
      source: { kind: 'head' },
      lifetime: 'managed',
    })
    await writeFile(join(created.path, 'committed.txt'), 'from commit\n', 'utf8')
    await git(created.path, 'add', 'committed.txt')
    await git(created.path, 'commit', '-m', 'agent result')
    await writeFile(join(created.path, 'README.md'), 'staged handoff\n', 'utf8')
    await git(created.path, 'add', 'README.md')
    await writeFile(join(created.path, 'README.md'), 'staged handoff\nworking handoff\n', 'utf8')
    await writeFile(join(created.path, 'untracked.txt'), 'untracked handoff\n', 'utf8')
    const before = await interrupted.inspect(created.id)

    await expect(interrupted.act({
      id: created.id,
      action: 'handoff',
      targetPath: fixture.repository,
      changeToken: before.changeToken,
    })).rejects.toThrow('simulated handoff crash')
    await interrupted.close()

    const reopened = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
    })
    cleanup.push(() => reopened.close())
    const report = await reopened.recover()
    expect(report.recovered).toContain(created.id)
    expect(report.manual).toHaveLength(0)
    const integrated = await reopened.inspect(created.id)
    expect(integrated.state).toBe('integrated')
    expect(integrated.lastDelivery).toMatchObject({ kind: 'handoff', target: fixture.repository })
    expect(await readFile(join(fixture.repository, 'committed.txt'), 'utf8')).toBe('from commit\n')
    expect(await readFile(join(fixture.repository, 'README.md'), 'utf8')).toBe('staged handoff\nworking handoff\n')
    expect(await readFile(join(fixture.repository, 'untracked.txt'), 'utf8')).toBe('untracked handoff\n')
    expect((await git(fixture.repository, 'diff', '--cached', '--name-only')).split(/\r?\n/u).sort()).toEqual(['README.md', 'committed.txt'])
    expect(await git(fixture.repository, 'diff', '--name-only')).toBe('README.md')
  }, 15_000)

  it('merges a committed result into a clean target branch and recovers after the merge commit', async () => {
    const fixture = await repositoryFixture()
    cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
    let crashed = false
    const interrupted = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
      onBoundary: async (boundary) => {
        if (!crashed && boundary === 'after-merge-committed') {
          crashed = true
          throw new Error('simulated merge crash')
        }
      },
    })
    const created = await interrupted.create({
      repository: fixture.repository,
      source: { kind: 'head' },
      lifetime: 'managed',
    })
    await writeFile(join(created.path, 'merged.txt'), 'merged result\n', 'utf8')
    await git(created.path, 'add', 'merged.txt')
    await git(created.path, 'commit', '-m', 'agent merge result')
    const before = await interrupted.inspect(created.id)
    await expect(interrupted.act({
      id: created.id,
      action: 'merge',
      targetPath: fixture.repository,
      changeToken: before.changeToken,
    })).rejects.toThrow('simulated merge crash')
    await interrupted.close()

    const reopened = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
    })
    cleanup.push(() => reopened.close())
    const report = await reopened.recover()
    expect(report.recovered).toContain(created.id)
    const integrated = await reopened.inspect(created.id)
    expect(integrated.state).toBe('integrated')
    expect(integrated.lastDelivery).toMatchObject({ kind: 'merge', target: fixture.repository })
    expect(await readFile(join(fixture.repository, 'merged.txt'), 'utf8')).toBe('merged result\n')
    expect(await git(fixture.repository, 'status', '--porcelain')).toBe('')
    expect(await git(fixture.repository, 'merge-base', '--is-ancestor', before.headCommit, 'HEAD').then(() => true)).toBe(true)
  }, 15_000)

  it('pushes an attached worktree branch without force and recovers after the remote update', async () => {
    const fixture = await repositoryFixture()
    cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
    const remote = join(fixture.root, 'origin.git')
    await execFileAsync('git', ['clone', '--bare', fixture.repository, remote])
    await git(fixture.repository, 'remote', 'add', 'origin', remote)
    let crashed = false
    const interrupted = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
      onBoundary: async (boundary) => {
        if (!crashed && boundary === 'after-push-updated-remote') {
          crashed = true
          throw new Error('simulated push crash')
        }
      },
    })
    const created = await interrupted.create({
      repository: fixture.repository,
      source: { kind: 'head' },
      lifetime: 'managed',
    })
    await writeFile(join(created.path, 'published.txt'), 'published result\n', 'utf8')
    await git(created.path, 'add', 'published.txt')
    await git(created.path, 'commit', '-m', 'publish result')
    let inspected = await interrupted.inspect(created.id)
    await interrupted.act({
      id: created.id,
      action: 'create-branch',
      name: 'dsh/published-result',
      changeToken: inspected.changeToken,
    })
    inspected = await interrupted.inspect(created.id)
    await expect(interrupted.act({
      id: created.id,
      action: 'push',
      remote: 'origin',
      changeToken: inspected.changeToken,
    })).rejects.toThrow('simulated push crash')
    await interrupted.close()

    const reopened = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
    })
    cleanup.push(() => reopened.close())
    const report = await reopened.recover()
    expect(report.recovered).toContain(created.id)
    const published = await reopened.inspect(created.id)
    expect(published.state).toBe('published')
    expect(published.lastDelivery).toMatchObject({ kind: 'push', target: 'origin/dsh/published-result' })
    expect(await git(fixture.repository, '--git-dir', remote, 'rev-parse', 'refs/heads/dsh/published-result')).toBe(published.headCommit)
  }, 15_000)

  it('idempotently resumes pull request publication after the forge accepted it', async () => {
    const fixture = await repositoryFixture()
    cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
    const remote = join(fixture.root, 'origin.git')
    await execFileAsync('git', ['clone', '--bare', fixture.repository, remote])
    await git(fixture.repository, 'remote', 'add', 'origin', remote)
    const ensure = vi.fn(async () => ({ url: 'https://example.invalid/pull/42' }))
    const publisher = { kind: 'test-forge', ensure }
    let crashed = false
    const interrupted = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
      pullRequestPublisher: publisher,
      onBoundary: async (boundary) => {
        if (!crashed && boundary === 'after-pull-request-created') {
          crashed = true
          throw new Error('simulated PR record crash')
        }
      },
    })
    const created = await interrupted.create({
      repository: fixture.repository,
      source: { kind: 'head' },
      lifetime: 'managed',
    })
    await writeFile(join(created.path, 'pull-request.txt'), 'PR result\n', 'utf8')
    await git(created.path, 'add', 'pull-request.txt')
    await git(created.path, 'commit', '-m', 'PR result')
    let inspected = await interrupted.inspect(created.id)
    await interrupted.act({
      id: created.id,
      action: 'create-branch',
      name: 'dsh/pull-request-result',
      changeToken: inspected.changeToken,
    })
    inspected = await interrupted.inspect(created.id)
    await expect(interrupted.act({
      id: created.id,
      action: 'pull-request',
      remote: 'origin',
      baseBranch: 'main',
      title: 'Deliver agent result',
      body: 'Verified result.',
      changeToken: inspected.changeToken,
    })).rejects.toThrow('simulated PR record crash')
    await interrupted.close()

    const reopened = createWorktreeManager({
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
      pullRequestPublisher: publisher,
    })
    cleanup.push(() => reopened.close())
    const report = await reopened.recover()
    expect(report.recovered).toContain(created.id)
    const published = await reopened.inspect(created.id)
    expect(published.state).toBe('published')
    expect(published.lastDelivery).toMatchObject({
      kind: 'pull-request',
      url: 'https://example.invalid/pull/42',
    })
    expect(ensure).toHaveBeenCalledTimes(2)
    expect(ensure).toHaveBeenLastCalledWith(expect.objectContaining({
      headBranch: 'dsh/pull-request-result',
      baseBranch: 'main',
    }))
  }, 15_000)

  it.each(['after-archive-artifact-ready', 'after-archive-removed'] as const)(
    'recovers an archive interrupted at %s',
    async (crashBoundary) => {
      const fixture = await repositoryFixture()
      cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
      let crashed = false
      const interrupted = createWorktreeManager({
        managedRoot: fixture.managedRoot,
        journalPath: fixture.journalPath,
        onBoundary: async (boundary) => {
          if (!crashed && boundary === crashBoundary) {
            crashed = true
            throw new Error(`simulated crash at ${boundary}`)
          }
        },
      })
      const created = await interrupted.create({
        repository: fixture.repository,
        source: { kind: 'head' },
        lifetime: 'managed',
      })
      await writeFile(join(created.path, 'agent.txt'), 'preserve me\n', 'utf8')
      const before = await interrupted.inspect(created.id)
      await expect(interrupted.act({ id: created.id, action: 'archive', changeToken: before.changeToken }))
        .rejects.toThrow(`simulated crash at ${crashBoundary}`)
      await interrupted.close()

      const reopened = createWorktreeManager({
        managedRoot: fixture.managedRoot,
        journalPath: fixture.journalPath,
      })
      cleanup.push(() => reopened.close())
      const report = await reopened.recover()
      expect(report.recovered).toContain(created.id)
      expect(report.manual).toHaveLength(0)
      expect((await reopened.inspect(created.id)).state).toBe('archived')
      await reopened.act({ id: created.id, action: 'restore' })
      expect(await readFile(join(created.path, 'agent.txt'), 'utf8')).toBe('preserve me\n')
    },
  )
})
