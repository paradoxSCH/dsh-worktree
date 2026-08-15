import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { WorktreeError } from './errors.js'
import type { GitCli } from './git.js'
import type { WorktreeId } from './types.js'

interface SnapshotFile {
  readonly path: string
  readonly mode: number
  readonly digest: string
  readonly data: Buffer
  readonly ignored: boolean
}

interface SnapshotMaterial {
  readonly stagedPatch: Buffer
  readonly workingPatch: Buffer
  readonly files: readonly SnapshotFile[]
  readonly digest: string
}

interface SnapshotManifest {
  readonly formatVersion: 1 | 2
  readonly worktreeId: WorktreeId
  readonly baseCommit: string
  readonly digest: string
  readonly files: readonly { readonly path: string; readonly mode: number; readonly digest: string; readonly ignored?: boolean }[]
}

/** Durable reference to one captured parent working state. */
export interface SnapshotArtifact {
  readonly directory: string
  readonly digest: string
}

export interface SnapshotCaptureOptions {
  readonly ignoredPatterns?: readonly string[]
  readonly allowSensitiveIgnored?: boolean
}

const MAX_SNAPSHOT_FILES = 2_000
const MAX_SNAPSHOT_FILE_BYTES = 32 * 1024 * 1024
const MAX_SNAPSHOT_TOTAL_BYTES = 128 * 1024 * 1024

function isSensitive(path: string): boolean {
  const normalized = path.toLowerCase()
  const base = normalized.split('/').at(-1) ?? normalized
  return base === '.env' || base.startsWith('.env.') || base === '.npmrc' || base === '.pypirc'
    || base === 'id_rsa' || base === 'id_ed25519' || base.endsWith('.pem') || base.endsWith('.key')
    || normalized.endsWith('/.aws/credentials') || normalized === '.aws/credentials'
}

async function worktreeIncludePatterns(repository: string): Promise<readonly string[]> {
  try {
    const text = await readFile(join(repository, '.worktreeinclude'), 'utf8')
    return text.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function assertRelativeGitPath(path: string): void {
  const segments = path.split('/')
  if (path === '' || isAbsolute(path) || segments.includes('..') || segments.includes('.git')) {
    throw new WorktreeError(`unsafe untracked path in working-state snapshot: ${path}`, 'WORKTREE_SNAPSHOT_PATH_UNSAFE')
  }
}

function assertDescendant(root: string, path: string): void {
  const relation = relative(root, path)
  if (relation === '' || relation.startsWith('..') || isAbsolute(relation)) {
    throw new WorktreeError(`snapshot path escapes its managed root: ${path}`, 'WORKTREE_SNAPSHOT_PATH_ESCAPE')
  }
}

function hashMaterial(stagedPatch: Buffer, workingPatch: Buffer, files: readonly SnapshotFile[], formatVersion: 1 | 2 = 2): string {
  const hash = createHash('sha256')
  hash.update(`dsh-worktree-snapshot-v${formatVersion}\0`)
  hash.update(stagedPatch)
  hash.update('\0working\0')
  hash.update(workingPatch)
  for (const file of files) {
    hash.update('\0file\0')
    hash.update(file.path)
    hash.update('\0')
    hash.update(String(file.mode))
    if (formatVersion >= 2) hash.update(file.ignored ? '\0ignored\0' : '\0untracked\0')
    hash.update('\0')
    hash.update(file.data)
  }
  return hash.digest('hex')
}

function decodeGitPaths(buffer: Buffer): string[] {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const paths: string[] = []
  let start = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue
    const path = decoder.decode(buffer.subarray(start, index))
    if (path !== '') paths.push(path)
    start = index + 1
  }
  return paths.sort((left, right) => left.localeCompare(right))
}

export class SourceSnapshotter {
  constructor(private readonly root: string, private readonly git: GitCli) {}

  async capture(
    repository: string,
    id: WorktreeId,
    baseCommit: string,
    artifactKey: string = id,
    options: SnapshotCaptureOptions = {},
  ): Promise<SnapshotArtifact> {
    const first = await this.captureMaterial(repository, baseCommit, options)
    const second = await this.captureMaterial(repository, baseCommit, options)
    if (first.digest !== second.digest) {
      throw new WorktreeError('parent working state changed while the snapshot was captured', 'WORKTREE_SNAPSHOT_RACED')
    }
    await mkdir(this.root, { recursive: true })
    const canonicalRoot = await realpath(this.root)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(artifactKey)) {
      throw new WorktreeError('snapshot artifact key is unsafe', 'WORKTREE_SNAPSHOT_KEY_UNSAFE')
    }
    const target = resolve(canonicalRoot, artifactKey)
    const temporary = resolve(canonicalRoot, `.${artifactKey}.${randomUUID()}.tmp`)
    assertDescendant(canonicalRoot, target)
    assertDescendant(canonicalRoot, temporary)
    await mkdir(join(temporary, 'files'), { recursive: true, mode: 0o700 })
    try {
      await writeFile(join(temporary, 'index.patch'), second.stagedPatch, { mode: 0o600 })
      await writeFile(join(temporary, 'working.patch'), second.workingPatch, { mode: 0o600 })
      for (const file of second.files) {
        const destination = resolve(temporary, 'files', ...file.path.split('/'))
        assertDescendant(temporary, destination)
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        await writeFile(destination, file.data, { flag: 'wx', mode: 0o600 })
      }
      const manifest: SnapshotManifest = {
        formatVersion: 2,
        worktreeId: id,
        baseCommit,
        digest: second.digest,
        files: second.files.map(file => ({ path: file.path, mode: file.mode, digest: file.digest, ignored: file.ignored })),
      }
      await writeFile(join(temporary, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600 })
      await rename(temporary, target)
      return { directory: target, digest: second.digest }
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
  }

  async load(id: WorktreeId, baseCommit: string, artifactKey: string): Promise<SnapshotArtifact | undefined> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(artifactKey)) {
      throw new WorktreeError('snapshot artifact key is unsafe', 'WORKTREE_SNAPSHOT_KEY_UNSAFE')
    }
    let canonicalRoot: string
    try {
      canonicalRoot = await realpath(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const target = resolve(canonicalRoot, artifactKey)
    assertDescendant(canonicalRoot, target)
    let directory: string
    try {
      directory = await realpath(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as SnapshotManifest
    if (![1, 2].includes(manifest.formatVersion) || manifest.worktreeId !== id || manifest.baseCommit !== baseCommit) {
      throw new WorktreeError('snapshot artifact identity does not match archive operation', 'WORKTREE_SNAPSHOT_IDENTITY_MISMATCH')
    }
    return { directory, digest: manifest.digest }
  }

  async fingerprint(repository: string, baseCommit: string, options: SnapshotCaptureOptions = {}): Promise<string> {
    const first = await this.captureMaterial(repository, baseCommit, options)
    const second = await this.captureMaterial(repository, baseCommit, options)
    if (first.digest !== second.digest) {
      throw new WorktreeError('worktree changed while its state was inspected', 'WORKTREE_INSPECTION_RACED')
    }
    return second.digest
  }

  emptyFingerprint(): string {
    return hashMaterial(Buffer.alloc(0), Buffer.alloc(0), [])
  }

  async replay(artifact: SnapshotArtifact, id: WorktreeId, baseCommit: string, worktreePath: string): Promise<void> {
    const canonicalRoot = await realpath(this.root)
    const directory = await realpath(artifact.directory)
    assertDescendant(canonicalRoot, directory)
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as SnapshotManifest
    if (![1, 2].includes(manifest.formatVersion) || manifest.worktreeId !== id || manifest.baseCommit !== baseCommit || manifest.digest !== artifact.digest) {
      throw new WorktreeError('working-state snapshot identity does not match the managed worktree', 'WORKTREE_SNAPSHOT_IDENTITY_MISMATCH')
    }
    const stagedPatch = await readFile(join(directory, 'index.patch'))
    const workingPatch = await readFile(join(directory, 'working.patch'))
    const files: SnapshotFile[] = []
    for (const entry of manifest.files) {
      assertRelativeGitPath(entry.path)
      const storedPath = resolve(directory, 'files', ...entry.path.split('/'))
      assertDescendant(directory, storedPath)
      const data = await readFile(storedPath)
      const digest = createHash('sha256').update(data).digest('hex')
      if (digest !== entry.digest) throw new WorktreeError(`snapshot file digest mismatch: ${entry.path}`, 'WORKTREE_SNAPSHOT_DIGEST_MISMATCH')
      files.push({ path: entry.path, mode: entry.mode, digest, data, ignored: entry.ignored ?? false })
    }
    if (hashMaterial(stagedPatch, workingPatch, files, manifest.formatVersion) !== artifact.digest) {
      throw new WorktreeError('working-state snapshot digest mismatch', 'WORKTREE_SNAPSHOT_DIGEST_MISMATCH')
    }
    await this.git.applyStagedPatch(worktreePath, stagedPatch)
    await this.git.applyWorkingPatch(worktreePath, workingPatch)
    for (const file of files) {
      const destination = resolve(worktreePath, ...file.path.split('/'))
      assertDescendant(worktreePath, destination)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, file.data, { flag: 'wx', mode: file.mode })
      if (process.platform !== 'win32') await chmod(destination, file.mode)
    }
  }

  async remove(artifact: SnapshotArtifact): Promise<void> {
    const canonicalRoot = await realpath(this.root)
    const directory = await realpath(artifact.directory)
    assertDescendant(canonicalRoot, directory)
    const status = await lstat(directory)
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new WorktreeError('snapshot artifact is not a real directory', 'WORKTREE_SNAPSHOT_PATH_UNSAFE')
    }
    await rm(directory, { recursive: true })
  }

  async removeReplayedUntrackedFiles(
    artifact: SnapshotArtifact,
    id: WorktreeId,
    baseCommit: string,
    destinationRoot: string,
  ): Promise<void> {
    const directory = await realpath(artifact.directory)
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as SnapshotManifest
    if (manifest.worktreeId !== id || manifest.baseCommit !== baseCommit || manifest.digest !== artifact.digest) {
      throw new WorktreeError('snapshot cleanup identity mismatch', 'WORKTREE_SNAPSHOT_IDENTITY_MISMATCH')
    }
    for (const entry of manifest.files) {
      assertRelativeGitPath(entry.path)
      const destination = resolve(destinationRoot, ...entry.path.split('/'))
      assertDescendant(destinationRoot, destination)
      try {
        await unlink(destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  private async captureMaterial(
    repository: string,
    baseCommit: string,
    options: SnapshotCaptureOptions = {},
  ): Promise<SnapshotMaterial> {
    const patterns = [...await worktreeIncludePatterns(repository), ...(options.ignoredPatterns ?? [])]
    const [stagedPatch, workingPatch, untracked, ignored] = await Promise.all([
      this.git.stagedPatch(repository, baseCommit),
      this.git.workingPatch(repository),
      this.git.untrackedPaths(repository),
      this.git.ignoredAllowlistPaths(repository, patterns),
    ])
    const files: SnapshotFile[] = []
    const selected = [
      ...decodeGitPaths(untracked).map(path => ({ path, ignored: false })),
      ...decodeGitPaths(ignored).map(path => ({ path, ignored: true })),
    ]
    if (selected.length > MAX_SNAPSHOT_FILES) {
      throw new WorktreeError('working-state snapshot exceeds the file-count limit', 'WORKTREE_SNAPSHOT_TOO_MANY_FILES')
    }
    let totalBytes = 0
    for (const entry of selected) {
      const { path } = entry
      assertRelativeGitPath(path)
      if (entry.ignored && isSensitive(path) && options.allowSensitiveIgnored !== true) {
        throw new WorktreeError(`sensitive ignored file requires explicit allowSensitiveIgnored: ${path}`, 'WORKTREE_SNAPSHOT_SENSITIVE_IGNORED')
      }
      const source = resolve(repository, ...path.split('/'))
      assertDescendant(repository, source)
      const status = await lstat(source)
      if (!status.isFile() || status.isSymbolicLink()) {
        throw new WorktreeError(`working-state snapshot supports only regular untracked files: ${path}`, 'WORKTREE_SNAPSHOT_UNSUPPORTED_FILE')
      }
      const data = await readFile(source)
      if (data.length > MAX_SNAPSHOT_FILE_BYTES) {
        throw new WorktreeError(`snapshot file exceeds the per-file limit: ${path}`, 'WORKTREE_SNAPSHOT_FILE_TOO_LARGE')
      }
      totalBytes += data.length
      if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
        throw new WorktreeError('working-state snapshot exceeds the total-byte limit', 'WORKTREE_SNAPSHOT_TOO_LARGE')
      }
      files.push({
        path: path.split(sep).join('/'),
        mode: status.mode & 0o777,
        digest: createHash('sha256').update(data).digest('hex'),
        data,
        ignored: entry.ignored,
      })
    }
    return { stagedPatch, workingPatch, files, digest: hashMaterial(stagedPatch, workingPatch, files) }
  }
}
