import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { WorktreeError } from './errors.js'

interface LockOwner {
  readonly version: 1
  readonly token: string
  readonly pid: number
  readonly hostname: string
  readonly acquiredAt: string
  readonly purpose: string
}

export interface DirectoryMutexOptions {
  readonly timeoutMs?: number
  readonly retryMs?: number
  readonly staleAfterMs?: number
}

function descendant(root: string, child: string): boolean {
  const relation = relative(root, child)
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation)
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

/**
 * Cross-process mutex implemented with atomic directory creation. Lock
 * directories contain only one identity file and are removed without a
 * recursive filesystem operation.
 */
export class DirectoryMutex {
  private readonly root: string
  private readonly timeoutMs: number
  private readonly retryMs: number
  private readonly staleAfterMs: number

  constructor(root: string, options: DirectoryMutexOptions = {}) {
    this.root = resolve(root)
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.retryMs = options.retryMs ?? 25
    this.staleAfterMs = options.staleAfterMs ?? 0
  }

  async withLock<T>(identity: string, purpose: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(identity, purpose)
    try {
      return await operation()
    } finally {
      await release()
    }
  }

  private async acquire(identity: string, purpose: string): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const key = createHash('sha256').update(identity).digest('hex')
    const directory = resolve(this.root, `${key}.lock`)
    if (!descendant(this.root, directory)) {
      throw new WorktreeError('lock path escaped its configured root', 'WORKTREE_LOCK_PATH_ESCAPE')
    }
    const ownerPath = join(directory, 'owner.json')
    const owner: LockOwner = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      purpose,
    }
    const deadline = Date.now() + this.timeoutMs
    while (true) {
      try {
        await mkdir(directory, { mode: 0o700 })
        await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (await this.removeStale(directory, ownerPath)) continue
        if (Date.now() >= deadline) {
          throw new WorktreeError(`timed out waiting for ${purpose} lock`, 'WORKTREE_LOCK_TIMEOUT')
        }
        await delay(this.retryMs)
      }
    }
    return async () => {
      let observed: LockOwner
      try {
        observed = JSON.parse(await readFile(ownerPath, 'utf8')) as LockOwner
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (observed.token !== owner.token) {
        throw new WorktreeError('lock ownership changed before release', 'WORKTREE_LOCK_IDENTITY_MISMATCH')
      }
      await unlink(ownerPath)
      await rmdir(directory)
    }
  }

  private async removeStale(directory: string, ownerPath: string): Promise<boolean> {
    let owner: LockOwner
    try {
      owner = JSON.parse(await readFile(ownerPath, 'utf8')) as LockOwner
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      return false
    }
    const age = Date.now() - Date.parse(owner.acquiredAt)
    const sameHostDeadProcess = owner.hostname === hostname() && !processExists(owner.pid)
    if (!sameHostDeadProcess || !Number.isFinite(age) || age < this.staleAfterMs) return false
    try {
      await unlink(ownerPath)
      await rmdir(directory)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      return false
    }
  }
}
