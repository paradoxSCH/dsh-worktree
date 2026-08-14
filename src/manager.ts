import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { WorktreeChangedError, WorktreeChangedSinceInspectionError, WorktreeError, WorktreeNotFoundError } from './errors.js'
import { GitCli } from './git.js'
import { OperationJournal, type JournalProjection, type WorktreeRecord } from './journal.js'
import { SourceSnapshotter } from './snapshot.js'
import type {
  ConcludeWorktreeRequest,
  CreateWorktreeRequest,
  WorktreeChanges,
  WorktreeId,
  WorktreeManager,
  WorktreeManagerOptions,
  WorktreeRecoveryReport,
  WorktreeView,
} from './types.js'

const EMPTY_CHANGES: WorktreeChanges = {
  dirty: false,
  stagedFileCount: 0,
  unstagedFileCount: 0,
  untrackedFileCount: 0,
  newCommitCount: 0,
}

function now(): string {
  return new Date().toISOString()
}

function comparePath(path: string): string {
  const normalized = resolve(path).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function assertManagedChild(root: string, child: string): void {
  const relation = relative(root, child)
  if (relation === '' || relation.startsWith('..') || isAbsolute(relation)) {
    throw new WorktreeError(`managed worktree path escapes configured root: ${child}`, 'WORKTREE_PATH_ESCAPE')
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function token(
  id: WorktreeId,
  headCommit: string,
  changes: WorktreeChanges,
  changedFromInitial: boolean,
  stateDigest: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ id, headCommit, changes, changedFromInitial, stateDigest }))
    .digest('hex')
}

export class LocalWorktreeManager implements WorktreeManager {
  private readonly git = new GitCli()
  private readonly journal: OperationJournal
  private readonly snapshotter: SourceSnapshotter
  private closed = false
  private operationTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: WorktreeManagerOptions) {
    this.journal = new OperationJournal(options.journalPath)
    this.snapshotter = new SourceSnapshotter(join(dirname(options.journalPath), 'snapshots'), this.git)
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new WorktreeError('worktree manager is closed', 'WORKTREE_MANAGER_CLOSED')
    const previous = this.operationTail
    let release: (() => void) | undefined
    this.operationTail = new Promise<void>((resolveTail) => { release = resolveTail })
    await previous
    try {
      return await operation()
    } finally {
      release?.()
    }
  }

  async create(request: CreateWorktreeRequest): Promise<WorktreeView> {
    return this.serialized(async () => {
      const sourceIdentity = await this.git.identify(request.repository)
      await mkdir(this.options.managedRoot, { recursive: true })
      const managedRoot = await realpath(this.options.managedRoot)
      if (comparePath(managedRoot) === comparePath(sourceIdentity.topLevel)) {
        throw new WorktreeError('managed root cannot be the source checkout', 'WORKTREE_ROOT_IS_SOURCE')
      }
      const id = randomUUID() as WorktreeId
      const path = resolve(managedRoot, id)
      assertManagedChild(managedRoot, path)
      const fresh = request.source.kind === 'fresh'
        ? await this.git.resolveRemoteCommit(sourceIdentity.topLevel, request.source.remote ?? 'origin', request.source.ref)
        : undefined
      const baseCommit = fresh?.commit ?? await this.git.resolveCommit(
        sourceIdentity.topLevel,
        request.source.kind === 'head' ? request.source.ref ?? 'HEAD' : 'HEAD',
      )
      const createdAt = now()
      const record: WorktreeRecord = {
        id,
        operationId: randomUUID(),
        repository: sourceIdentity.topLevel,
        commonDirectory: sourceIdentity.commonDirectory,
        path,
        baseCommit,
        lifetime: request.lifetime,
        sourceKind: request.source.kind,
        createdAt,
      }
      await this.journal.append({ kind: 'worktree_create_planned', at: createdAt, record })
      try {
        await this.boundary('after-create-planned', id)
        if (fresh !== undefined) {
          await this.git.fetchRemoteCommit(
            sourceIdentity.topLevel,
            request.source.kind === 'fresh' ? request.source.remote ?? 'origin' : 'origin',
            fresh.ref,
            `refs/dsh-worktree/fetch/${id}`,
            baseCommit,
          )
        }
        const snapshot = request.source.kind === 'working-state'
          ? await this.snapshotter.capture(sourceIdentity.topLevel, id, baseCommit)
          : undefined
        if (snapshot !== undefined) {
          await this.journal.append({ kind: 'worktree_snapshot_ready', at: now(), id, artifact: snapshot })
          await this.boundary('after-snapshot-ready', id)
        }
        await this.git.addLocked(sourceIdentity.topLevel, path, baseCommit, `dsh:${id}`)
        await this.boundary('after-worktree-added', id)
        const createdIdentity = await this.git.verify(path, sourceIdentity.commonDirectory)
        if (createdIdentity.headCommit !== baseCommit) {
          throw new Error(`worktree HEAD mismatch: expected ${baseCommit}, observed ${createdIdentity.headCommit}`)
        }
        if (snapshot !== undefined) {
          await this.snapshotter.replay(snapshot, id, baseCommit, path)
          await this.boundary('after-snapshot-replayed', id)
        }
        const initialStateDigest = await this.snapshotter.fingerprint(path, baseCommit)
        if (snapshot !== undefined && initialStateDigest !== snapshot.digest) {
          throw new WorktreeError('replayed working state differs from its durable snapshot', 'WORKTREE_SNAPSHOT_REPLAY_MISMATCH')
        }
        await this.journal.append({ kind: 'worktree_ready', at: now(), id, initialStateDigest })
        await this.boundary('after-ready', id)
      } catch (error) {
        await this.journal.append({
          kind: 'worktree_recovery_needed',
          at: now(),
          id,
          reason: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
      return this.inspectUnserialized(id)
    })
  }

  inspect(id: WorktreeId): Promise<WorktreeView> {
    return this.serialized(() => this.inspectUnserialized(id))
  }

  private async inspectUnserialized(id: WorktreeId): Promise<WorktreeView> {
    const projection = (await this.journal.project()).get(id)
    if (projection === undefined) throw new WorktreeNotFoundError(id)
    if (projection.state === 'removed') return this.removedView(projection)
    await this.git.verify(projection.record.path, projection.record.commonDirectory)
    const observed = await this.git.changes(projection.record.path, projection.record.baseCommit)
    const currentStateDigest = await this.snapshotter.fingerprint(projection.record.path, projection.record.baseCommit)
    if (projection.initialStateDigest === undefined) {
      throw new WorktreeError(`worktree ${id} has no committed initial-state digest`, 'WORKTREE_INITIAL_STATE_MISSING')
    }
    const changedFromInitial = currentStateDigest !== projection.initialStateDigest
    return {
      id,
      state: projection.state,
      path: projection.record.path,
      repository: projection.record.repository,
      baseCommit: projection.record.baseCommit,
      headCommit: observed.headCommit,
      lifetime: projection.record.lifetime,
      changes: observed.changes,
      changedFromInitial,
      changeToken: token(id, observed.headCommit, observed.changes, changedFromInitial, currentStateDigest),
      createdAt: projection.record.createdAt,
      updatedAt: projection.updatedAt,
    }
  }

  async conclude(request: ConcludeWorktreeRequest): Promise<WorktreeView> {
    return this.serialized(async () => {
      const before = await this.inspectUnserialized(request.id)
      if (before.state === 'removed') return before
      if (request.action === 'retain') {
        await this.git.unlock(before.repository, before.path)
        await this.journal.append({
          kind: 'worktree_retained',
          at: now(),
          id: before.id,
          changes: before.changes,
          changedFromInitial: before.changedFromInitial,
          headCommit: before.headCommit,
        })
        return this.inspectUnserialized(before.id)
      }
      if (request.action === 'remove-clean' && before.changedFromInitial) {
        throw new WorktreeChangedError(before.id)
      }
      if (request.action === 'discard' && request.changeToken !== before.changeToken) {
        throw new WorktreeChangedSinceInspectionError(before.id)
      }
      await this.git.verify(before.path, (await this.projection(before.id)).record.commonDirectory)
      await this.git.unlock(before.repository, before.path)
      // Git refuses to remove a worktree containing the inherited working state.
      // The destructive decision was made above by comparing the complete state
      // fingerprint, so --force here is only the transport required by Git.
      await this.git.remove(before.repository, before.path, request.action === 'discard' || before.changes.dirty)
      const projection = await this.projection(before.id)
      await this.journal.append({
        kind: 'worktree_removed',
        at: now(),
        id: before.id,
        changes: before.changes,
        changedFromInitial: before.changedFromInitial,
        headCommit: before.headCommit,
      })
      if (projection.snapshot !== undefined) await this.snapshotter.remove(projection.snapshot)
      return this.inspectUnserialized(before.id)
    })
  }

  async list(): Promise<readonly WorktreeView[]> {
    return this.serialized(async () => {
      const projections = [...(await this.journal.project()).values()]
      const views: WorktreeView[] = []
      for (const projection of projections) {
        if (projection.state === 'removed' || projection.state === 'creating' || projection.state === 'recovery-needed') {
          views.push(this.inactiveView(projection))
        } else views.push(await this.inspectUnserialized(projection.record.id))
      }
      return views
    })
  }

  recover(): Promise<WorktreeRecoveryReport> {
    return this.serialized(async () => {
      const recovered: WorktreeId[] = []
      const manual: Array<{ id: WorktreeId; reason: string }> = []
      const projections = [...(await this.journal.project()).values()]
      for (const projection of projections) {
        if (projection.state !== 'creating' && projection.state !== 'recovery-needed') continue
        try {
          await this.recoverOne(projection)
          recovered.push(projection.record.id)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          await this.journal.append({ kind: 'worktree_recovery_needed', at: now(), id: projection.record.id, reason })
          manual.push({ id: projection.record.id, reason })
        }
      }
      return { recovered, manual }
    })
  }

  async close(): Promise<void> {
    this.closed = true
    await this.operationTail
  }

  private async projection(id: WorktreeId): Promise<JournalProjection> {
    const projection = (await this.journal.project()).get(id)
    if (projection === undefined) throw new WorktreeNotFoundError(id)
    return projection
  }

  private async boundary(boundary: import('./types.js').WorktreeBoundary, id: WorktreeId): Promise<void> {
    await this.options.onBoundary?.(boundary, id)
  }

  private async recoverOne(projection: JournalProjection): Promise<void> {
    const { record } = projection
    const hasPath = await pathExists(record.path)
    if (!hasPath) {
      if (record.sourceKind === 'working-state' && projection.snapshot === undefined) {
        throw new WorktreeError('working-state snapshot was not durably captured before interruption', 'WORKTREE_RECOVERY_SNAPSHOT_MISSING')
      }
      await this.git.addLocked(record.repository, record.path, record.baseCommit, `dsh:${record.id}`)
    }
    await this.git.verify(record.path, record.commonDirectory)
    let digest = await this.snapshotter.fingerprint(record.path, record.baseCommit)
    if (record.sourceKind === 'working-state') {
      const snapshot = projection.snapshot
      if (snapshot === undefined) {
        throw new WorktreeError('working-state recovery has no durable snapshot', 'WORKTREE_RECOVERY_SNAPSHOT_MISSING')
      }
      if (digest === this.snapshotter.emptyFingerprint()) {
        await this.snapshotter.replay(snapshot, record.id, record.baseCommit, record.path)
        digest = await this.snapshotter.fingerprint(record.path, record.baseCommit)
      }
      if (digest !== snapshot.digest) {
        throw new WorktreeError('interrupted worktree differs from both its empty and captured states', 'WORKTREE_RECOVERY_AMBIGUOUS_STATE')
      }
    } else if (digest !== this.snapshotter.emptyFingerprint()) {
      throw new WorktreeError('interrupted worktree contains unplanned changes', 'WORKTREE_RECOVERY_AMBIGUOUS_STATE')
    }
    await this.journal.append({ kind: 'worktree_ready', at: now(), id: record.id, initialStateDigest: digest })
  }

  private removedView(projection: JournalProjection): WorktreeView {
    const changes = projection.lastChanges ?? EMPTY_CHANGES
    const changedFromInitial = projection.lastChangedFromInitial ?? false
    const headCommit = projection.lastHeadCommit ?? projection.record.baseCommit
    return {
      id: projection.record.id,
      state: 'removed',
      path: projection.record.path,
      repository: projection.record.repository,
      baseCommit: projection.record.baseCommit,
      headCommit,
      lifetime: projection.record.lifetime,
      changes,
      changedFromInitial,
      changeToken: token(
        projection.record.id,
        headCommit,
        changes,
        changedFromInitial,
        projection.initialStateDigest ?? '',
      ),
      createdAt: projection.record.createdAt,
      updatedAt: projection.updatedAt,
    }
  }

  private inactiveView(projection: JournalProjection): WorktreeView {
    const changes = projection.lastChanges ?? EMPTY_CHANGES
    const headCommit = projection.lastHeadCommit ?? projection.record.baseCommit
    const changedFromInitial = projection.lastChangedFromInitial ?? false
    return {
      id: projection.record.id,
      state: projection.state,
      path: projection.record.path,
      repository: projection.record.repository,
      baseCommit: projection.record.baseCommit,
      headCommit,
      lifetime: projection.record.lifetime,
      changes,
      changedFromInitial,
      changeToken: token(projection.record.id, headCommit, changes, changedFromInitial, projection.initialStateDigest ?? ''),
      createdAt: projection.record.createdAt,
      updatedAt: projection.updatedAt,
    }
  }
}
