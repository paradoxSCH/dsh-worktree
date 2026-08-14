import { execFile, spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
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

  async unlock(repository: string, path: string): Promise<void> {
    await this.run(repository, ['worktree', 'unlock', path])
  }

  async remove(repository: string, path: string, force: boolean): Promise<void> {
    await this.run(repository, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
  }
}
