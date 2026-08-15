import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { WorktreeChanges } from './types.js'

const execFileAsync = promisify(execFile)
const REDIRECTING_GIT_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
])

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const name of REDIRECTING_GIT_ENV) delete environment[name]
  environment.GIT_TERMINAL_PROMPT = '0'
  return environment
}

function canonicalForComparison(path: string): string {
  const normalized = resolve(path).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export interface RepositoryIdentity {
  readonly topLevel: string
  readonly commonDirectory: string
  readonly headCommit: string
}

export interface LinkedWorktree {
  readonly path: string
  readonly locked: boolean
  readonly lockReason?: string
}

export interface GitReview {
  readonly summary: string
  readonly diff: string
  readonly untrackedPaths: readonly string[]
  readonly truncated: boolean
}

function assertRemoteName(remote: string): void {
  if (remote === '' || remote.startsWith('-') || /[\0\r\n]/u.test(remote)) {
    throw new Error(`invalid Git remote name: ${JSON.stringify(remote)}`)
  }
}

function normalizeRemoteRef(ref: string | undefined): string {
  if (ref === undefined) return 'HEAD'
  if (
    ref === '' || ref.startsWith('-') || /[\0-\x20~^:?*[\\]/u.test(ref)
    || ref.includes('..') || ref.includes('@{') || ref.endsWith('.') || ref.endsWith('/')
  ) {
    throw new Error(`invalid remote Git ref: ${JSON.stringify(ref)}`)
  }
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`
}

function assertInternalRef(ref: string): void {
  if (!/^refs\/dsh-worktree\/[A-Za-z0-9._/-]+$/u.test(ref) || ref.includes('..') || ref.endsWith('/')) {
    throw new Error(`invalid internal Git ref: ${JSON.stringify(ref)}`)
  }
}

export class GitCli {
  private async runBuffer(cwd: string, args: readonly string[]): Promise<Buffer> {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'buffer',
      env: gitEnvironment(),
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    })
    return stdout
  }

  private async run(cwd: string, args: readonly string[]): Promise<string> {
    return (await this.runBuffer(cwd, args)).toString('utf8').trim()
  }

  async version(cwd: string): Promise<string> {
    return this.run(cwd, ['--version'])
  }

  private runWithInput(cwd: string, args: readonly string[], input: Buffer): Promise<void> {
    return new Promise<void>((resolveRun, rejectRun) => {
      const child = spawn('git', [...args], {
        cwd,
        env: gitEnvironment(),
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      })
      const errors: Buffer[] = []
      child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
      child.on('error', rejectRun)
      child.on('close', (code) => {
        if (code === 0) resolveRun()
        else rejectRun(new Error(`git ${args.join(' ')} failed (${code ?? 'signal'}): ${Buffer.concat(errors).toString('utf8').trim()}`))
      })
      child.stdin.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EPIPE') rejectRun(error)
      })
      child.stdin.end(input)
    })
  }

  async identify(repository: string): Promise<RepositoryIdentity> {
    const requested = await realpath(repository)
    const topLevelRaw = await this.run(requested, ['rev-parse', '--show-toplevel'])
    const topLevel = await realpath(isAbsolute(topLevelRaw) ? topLevelRaw : resolve(requested, topLevelRaw))
    const commonRaw = await this.run(topLevel, ['rev-parse', '--git-common-dir'])
    const commonDirectory = await realpath(isAbsolute(commonRaw) ? commonRaw : resolve(topLevel, commonRaw))
    const headCommit = await this.run(topLevel, ['rev-parse', 'HEAD^{commit}'])
    return { topLevel, commonDirectory, headCommit }
  }

  resolveCommit(repository: string, ref: string): Promise<string> {
    return this.run(repository, ['rev-parse', '--verify', `${ref}^{commit}`])
  }

  async resolveRemoteCommit(repository: string, remote: string, ref?: string): Promise<{ readonly commit: string; readonly ref: string }> {
    assertRemoteName(remote)
    const normalizedRef = normalizeRemoteRef(ref)
    // Require a configured remote name rather than accepting an arbitrary URL
    // from model- or config-originated input.
    await this.run(repository, ['remote', 'get-url', remote])
    const output = await this.run(repository, [
      'ls-remote', '--exit-code', ...(normalizedRef === 'HEAD' ? [] : ['--refs']), remote, normalizedRef,
    ])
    const matches = output.split('\n').filter(Boolean).map(line => line.split(/\s+/u)).filter(parts => parts[1] === normalizedRef)
    if (matches.length !== 1 || !/^[0-9a-f]{40}$/u.test(matches[0]?.[0] ?? '')) {
      throw new Error(`remote ${remote} did not resolve ${normalizedRef} to exactly one commit`)
    }
    return { commit: matches[0]![0]!, ref: normalizedRef }
  }

  async fetchRemoteCommit(repository: string, remote: string, sourceRef: string, destinationRef: string, expectedCommit: string): Promise<void> {
    assertRemoteName(remote)
    await this.run(repository, ['fetch', '--no-tags', '--force', remote, `${sourceRef}:${destinationRef}`])
    const observed = await this.resolveCommit(repository, destinationRef)
    if (observed !== expectedCommit) {
      throw new Error(`remote ref moved while creating worktree: expected ${expectedCommit}, fetched ${observed}`)
    }
  }

  stagedPatch(repository: string, baseCommit: string): Promise<Buffer> {
    return this.runBuffer(repository, ['diff', '--binary', '--full-index', '--cached', baseCommit])
  }

  workingPatch(repository: string): Promise<Buffer> {
    return this.runBuffer(repository, ['diff', '--binary', '--full-index'])
  }

  untrackedPaths(repository: string): Promise<Buffer> {
    return this.runBuffer(repository, ['ls-files', '--others', '--exclude-standard', '-z'])
  }

  async ignoredAllowlistPaths(repository: string, patterns: readonly string[]): Promise<Buffer> {
    if (patterns.length === 0) return Buffer.alloc(0)
    if (patterns.some(pattern => pattern.includes('\0') || pattern.includes('\r') || pattern.includes('\n'))) {
      throw new Error('ignored include patterns cannot contain NUL or newlines')
    }
    const candidates = await this.runBuffer(repository, [
      'ls-files', '--others', '--ignored', '-z', ...patterns.map(pattern => `--exclude=${pattern}`),
    ])
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const included: Buffer[] = []
    let start = 0
    for (let index = 0; index < candidates.length; index += 1) {
      if (candidates[index] !== 0) continue
      const raw = candidates.subarray(start, index)
      const path = decoder.decode(raw)
      start = index + 1
      if (path === '') continue
      try {
        await this.run(repository, ['check-ignore', '--quiet', '--', path])
        included.push(raw, Buffer.from([0]))
      } catch {
        // A pattern match that is not actually Git-ignored is not eligible.
      }
    }
    return Buffer.concat(included)
  }

  async applyStagedPatch(path: string, patch: Buffer): Promise<void> {
    if (patch.length === 0) return
    await this.runWithInput(path, ['apply', '--binary', '--index', '--whitespace=nowarn', '-'], patch)
  }

  async applyWorkingPatch(path: string, patch: Buffer): Promise<void> {
    if (patch.length === 0) return
    await this.runWithInput(path, ['apply', '--binary', '--whitespace=nowarn', '-'], patch)
  }

  async addLocked(repository: string, path: string, commit: string, reason: string): Promise<void> {
    await this.run(repository, ['worktree', 'add', '--detach', '--lock', '--reason', reason, path, commit])
  }

  async verify(path: string, expectedCommonDirectory: string): Promise<RepositoryIdentity> {
    const identity = await this.identify(path)
    if (canonicalForComparison(identity.topLevel) !== canonicalForComparison(path)) {
      throw new Error(`worktree top-level identity mismatch: expected ${path}, observed ${identity.topLevel}`)
    }
    if (canonicalForComparison(identity.commonDirectory) !== canonicalForComparison(expectedCommonDirectory)) {
      throw new Error('worktree Git common-directory identity mismatch')
    }
    return identity
  }

  async changes(path: string, baseCommit: string): Promise<{ readonly headCommit: string; readonly changes: WorktreeChanges }> {
    const status = await this.run(path, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
    let stagedFileCount = 0
    let unstagedFileCount = 0
    let untrackedFileCount = 0
    for (const entry of status.split('\0')) {
      if (entry === '') continue
      if (entry.startsWith('? ')) {
        untrackedFileCount += 1
        continue
      }
      if (entry.startsWith('1 ') || entry.startsWith('2 ') || entry.startsWith('u ')) {
        const x = entry[2]
        const y = entry[3]
        if (x !== undefined && x !== '.') stagedFileCount += 1
        if (y !== undefined && y !== '.') unstagedFileCount += 1
      }
    }
    const headCommit = await this.run(path, ['rev-parse', 'HEAD^{commit}'])
    const count = await this.run(path, ['rev-list', '--count', `${baseCommit}..${headCommit}`])
    const newCommitCount = Number.parseInt(count, 10)
    if (!Number.isSafeInteger(newCommitCount) || newCommitCount < 0) {
      throw new Error(`Git returned an invalid commit count: ${count}`)
    }
    return {
      headCommit,
      changes: {
        dirty: stagedFileCount + unstagedFileCount + untrackedFileCount > 0,
        stagedFileCount,
        unstagedFileCount,
        untrackedFileCount,
        newCommitCount,
      },
    }
  }

  async listLinkedWorktrees(repository: string): Promise<readonly LinkedWorktree[]> {
    const output = (await this.runBuffer(repository, ['worktree', 'list', '--porcelain', '-z'])).toString('utf8')
    const records: Array<{ path: string; locked: boolean; lockReason?: string }> = []
    let current: { path: string; locked: boolean; lockReason?: string } | undefined
    for (const raw of output.split('\0')) {
      const field = raw.replace(/^\n+/u, '')
      if (field.startsWith('worktree ')) {
        if (current !== undefined) records.push(current)
        current = { path: field.slice('worktree '.length), locked: false }
      } else if (field === 'locked' && current !== undefined) {
        current.locked = true
      } else if (field.startsWith('locked ') && current !== undefined) {
        current.locked = true
        current.lockReason = field.slice('locked '.length)
      }
    }
    if (current !== undefined) records.push(current)
    return records
  }

  async review(path: string, baseCommit: string, maxBytes: number): Promise<GitReview> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16 * 1024 * 1024) {
      throw new Error('review byte limit must be between 1 KiB and 16 MiB')
    }
    const [summary, diff, untracked] = await Promise.all([
      this.run(path, ['diff', '--stat', baseCommit]),
      this.runBuffer(path, ['diff', '--binary', '--full-index', baseCommit]),
      this.untrackedPaths(path),
    ])
    const truncated = diff.length > maxBytes
    const selected = truncated ? diff.subarray(0, maxBytes) : diff
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const untrackedPaths: string[] = []
    let start = 0
    for (let index = 0; index < untracked.length; index += 1) {
      if (untracked[index] !== 0) continue
      const value = decoder.decode(untracked.subarray(start, index))
      if (value !== '') untrackedPaths.push(value)
      start = index + 1
    }
    return {
      summary,
      diff: selected.toString('utf8'),
      untrackedPaths,
      truncated,
    }
  }

  async preserveRef(repository: string, ref: string, commit: string): Promise<void> {
    assertInternalRef(ref)
    const existing = await this.resolveOptionalCommit(repository, ref)
    if (existing !== undefined && existing !== commit) {
      throw new Error(`preservation ref ${ref} already points to a different commit`)
    }
    if (existing === commit) return
    await this.run(repository, ['update-ref', ref, commit, '0'.repeat(40)])
  }

  async currentBranch(path: string): Promise<string | null> {
    try {
      return await this.run(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    } catch {
      return null
    }
  }

  async branchCommit(repository: string, name: string): Promise<string | undefined> {
    await this.validateBranchName(repository, name)
    return this.resolveOptionalCommit(repository, `refs/heads/${name}`)
  }

  async attachBranch(path: string, name: string, expectedHead: string): Promise<void> {
    await this.validateBranchName(path, name)
    const existing = await this.resolveOptionalCommit(path, `refs/heads/${name}`)
    if (existing !== undefined && existing !== expectedHead) {
      throw new Error(`branch ${name} already exists at a different commit`)
    }
    if (existing === undefined) await this.run(path, ['switch', '-c', name])
    else await this.run(path, ['switch', name])
    const observed = await this.resolveCommit(path, 'HEAD')
    if (observed !== expectedHead) throw new Error(`branch ${name} did not attach at the expected commit`)
  }

  private async validateBranchName(repository: string, name: string): Promise<void> {
    if (name === '' || name.startsWith('-') || name.includes('\0')) throw new Error('invalid branch name')
    await this.run(repository, ['check-ref-format', '--branch', name])
  }

  private async resolveOptionalCommit(repository: string, ref: string): Promise<string | undefined> {
    try {
      return await this.resolveCommit(repository, ref)
    } catch {
      return undefined
    }
  }

  async unlock(repository: string, path: string): Promise<void> {
    await this.run(repository, ['worktree', 'unlock', path])
  }

  async unlockForRemoval(repository: string, path: string): Promise<void> {
    try {
      await this.unlock(repository, path)
    } catch {
      // Removal below is authoritative: it succeeds when already unlocked and
      // fails safely when another lock or Git topology condition still blocks it.
    }
  }

  async remove(repository: string, path: string, force: boolean): Promise<void> {
    await this.run(repository, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
  }

  async resetHard(path: string, commit: string): Promise<void> {
    await this.run(path, ['reset', '--hard', commit])
  }

  async stageAll(path: string): Promise<void> {
    await this.run(path, ['add', '--all'])
  }

  async commitStaged(path: string, message: string): Promise<string> {
    if (message.trim() === '' || message.length > 4096 || message.includes('\0')) {
      throw new Error('commit message must contain 1 to 4096 characters and no NUL byte')
    }
    await this.run(path, ['commit', '--message', message])
    return this.resolveCommit(path, 'HEAD')
  }

  async commitContentDigest(path: string): Promise<string> {
    const hash = createHash('sha256')
    hash.update('dsh-worktree-commit-content-v1\0')
    const [changedRaw, untrackedRaw] = await Promise.all([
      this.runBuffer(path, ['diff', '--name-only', '-z', 'HEAD', '--']),
      this.untrackedPaths(path),
    ])
    const names = new Set([
      ...changedRaw.toString('utf8').split('\0').filter(Boolean),
      ...untrackedRaw.toString('utf8').split('\0').filter(Boolean),
    ])
    if (names.size > 2000) throw new Error('commit refuses more than 2000 changed paths')
    for (const name of [...names].sort()) {
      hash.update('\0path\0')
      hash.update(name)
      let stat
      try {
        stat = await lstat(resolve(path, name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        hash.update('\0missing')
        continue
      }
      hash.update(`\0mode\0${stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.mode & 0o111 ? 'executable' : 'file'}`)
      if (stat.isDirectory()) {
        hash.update('\0submodule\0')
        hash.update(await this.run(resolve(path, name), ['rev-parse', 'HEAD^{commit}']))
      } else {
        hash.update('\0object\0')
        hash.update(await this.run(path, ['hash-object', '--no-filters', '--', name]))
      }
    }
    return hash.digest('hex')
  }

  async mergeNoEdit(path: string, sourceCommit: string): Promise<void> {
    await this.run(path, ['merge', '--no-ff', '--no-edit', sourceCommit])
  }

  async abortMerge(path: string): Promise<void> {
    try {
      await this.run(path, ['merge', '--abort'])
    } catch {
      // No merge in progress is already the desired recovery state.
    }
  }

  async isAncestor(path: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.run(path, ['merge-base', '--is-ancestor', ancestor, descendant])
      return true
    } catch {
      return false
    }
  }

  async pushBranch(path: string, remote: string, branch: string): Promise<void> {
    assertRemoteName(remote)
    await this.validateBranchName(path, branch)
    await this.run(path, ['remote', 'get-url', remote])
    await this.run(path, ['push', '--porcelain', remote, `HEAD:refs/heads/${branch}`])
  }

  async remoteBranchCommit(path: string, remote: string, branch: string): Promise<string | undefined> {
    assertRemoteName(remote)
    await this.validateBranchName(path, branch)
    const ref = `refs/heads/${branch}`
    let output: string
    try {
      output = await this.run(path, ['ls-remote', '--exit-code', '--refs', remote, ref])
    } catch {
      return undefined
    }
    const rows = output.split('\n').filter(Boolean).map(row => row.split(/\s+/u))
    if (rows.length !== 1 || rows[0]?.[1] !== ref || !/^[0-9a-f]{40}$/u.test(rows[0]?.[0] ?? '')) {
      throw new Error(`remote ${remote} returned an ambiguous value for ${ref}`)
    }
    return rows[0]![0]!
  }
}
