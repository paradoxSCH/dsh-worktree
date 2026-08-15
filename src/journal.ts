import { open, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DeliverySummary, LifetimePolicy, ValidationSummary, WorktreeChanges, WorktreeId, WorktreeLease, WorktreeState } from './types.js'
import type { SnapshotArtifact } from './snapshot.js'
import { DirectoryMutex } from './lock.js'

export interface WorktreeRecord {
  readonly formatVersion: 1
  readonly id: WorktreeId
  readonly operationId: string
  readonly repository: string
  readonly commonDirectory: string
  readonly path: string
  readonly baseCommit: string
  readonly lifetime: LifetimePolicy
  readonly sourceKind: 'head' | 'fresh' | 'working-state'
  readonly ignoredPatterns: readonly string[]
  readonly allowSensitiveIgnored: boolean
  readonly createdAt: string
}

export type ConcludeOperationKind = 'retain' | 'remove-clean' | 'discard'

export interface PlannedConcludeOperation {
  readonly operationId: string
  readonly action: ConcludeOperationKind
  readonly changeToken: string
  readonly changes: WorktreeChanges
  readonly changedFromInitial: boolean
  readonly headCommit: string
}

export interface ArchiveArtifact {
  readonly ref: string
  readonly headCommit: string
  readonly snapshot: SnapshotArtifact | undefined
}

export interface PlannedArchiveOperation {
  readonly operationId: string
  readonly changeToken: string
  readonly headCommit: string
  readonly changes: WorktreeChanges
  readonly changedFromInitial: boolean
  readonly branch: string | null
}

export interface PlannedBranchOperation {
  readonly operationId: string
  readonly name: string
  readonly changeToken: string
  readonly headCommit: string
}

export interface PlannedCommitOperation {
  readonly operationId: string
  readonly message: string
  readonly changeToken: string
  readonly previousHeadCommit: string
  readonly contentDigest: string
}

export interface PlannedHandoffOperation {
  readonly operationId: string
  readonly targetPath: string
  readonly changeToken: string
  readonly baseCommit: string
  readonly headCommit: string
}

export interface PlannedMergeOperation {
  readonly operationId: string
  readonly targetPath: string
  readonly targetBranch: string
  readonly targetHeadCommit: string
  readonly sourceHeadCommit: string
  readonly changeToken: string
}

export interface PlannedPushOperation {
  readonly operationId: string
  readonly remote: string
  readonly branch: string
  readonly headCommit: string
  readonly changeToken: string
}

export interface PlannedPullRequestOperation {
  readonly operationId: string
  readonly remote: string
  readonly branch: string
  readonly baseBranch: string | undefined
  readonly title: string
  readonly body: string
  readonly headCommit: string
  readonly changeToken: string
}

export type JournalEvent =
  | { readonly kind: 'worktree_create_planned'; readonly at: string; readonly record: WorktreeRecord }
  | { readonly kind: 'worktree_snapshot_ready'; readonly at: string; readonly id: WorktreeId; readonly artifact: SnapshotArtifact }
  | { readonly kind: 'worktree_ready'; readonly at: string; readonly id: WorktreeId; readonly initialStateDigest: string }
  | { readonly kind: 'worktree_lease_acquired'; readonly at: string; readonly id: WorktreeId; readonly lease: WorktreeLease }
  | { readonly kind: 'worktree_lease_released'; readonly at: string; readonly id: WorktreeId; readonly leaseId: string }
  | { readonly kind: 'worktree_archive_planned'; readonly at: string; readonly id: WorktreeId; readonly operation: PlannedArchiveOperation }
  | { readonly kind: 'worktree_archive_artifact_ready'; readonly at: string; readonly id: WorktreeId; readonly operationId: string; readonly artifact: ArchiveArtifact }
  | { readonly kind: 'worktree_archived'; readonly at: string; readonly id: WorktreeId; readonly operationId: string }
  | { readonly kind: 'worktree_restore_planned'; readonly at: string; readonly id: WorktreeId; readonly operationId: string }
  | { readonly kind: 'worktree_restored'; readonly at: string; readonly id: WorktreeId; readonly operationId: string }
  | { readonly kind: 'worktree_validation_completed'; readonly at: string; readonly id: WorktreeId; readonly validation: ValidationSummary }
  | { readonly kind: 'worktree_commit_planned'; readonly at: string; readonly id: WorktreeId; readonly operation: PlannedCommitOperation }
  | { readonly kind: 'worktree_commit_completed'; readonly at: string; readonly id: WorktreeId; readonly operationId: string; readonly delivery: DeliverySummary }
  | { readonly kind: 'worktree_branch_planned'; readonly at: string; readonly id: WorktreeId; readonly operation: PlannedBranchOperation }
  | { readonly kind: 'worktree_branch_completed'; readonly at: string; readonly id: WorktreeId; readonly operationId: string; readonly branch: string }
  | { readonly kind: 'worktree_handoff_planned'; readonly at: string; readonly id: WorktreeId; readonly operation: PlannedHandoffOperation }
  | { readonly kind: 'worktree_handoff_artifact_ready'; readonly at: string; readonly id: WorktreeId; readonly operationId: string; readonly artifact: SnapshotArtifact }
  | { readonly kind: 'worktree_handoff_completed'; readonly at: string; readonly id: WorktreeId; readonly operationId: string; readonly delivery: DeliverySummary }
  | { readonly kind: 'worktree_merge_planned'; readonly at: string; readonly id: WorktreeId; readonly operation: PlannedMergeOperation }
  | { readonly kind: 'worktree_merge_completed'; readonly at: string; readonly id: WorktreeId; readonly operationId: string; readonly delivery: DeliverySummary }
  | { readonly kind: 'worktree_push_planned'; readonly at: string; readonly id: WorktreeId; readonly operation: PlannedPushOperation }
  | { readonly kind: 'worktree_push_completed'; readonly at: string; readonly id: WorktreeId; readonly operationId: string; readonly delivery: DeliverySummary }
  | { readonly kind: 'worktree_pull_request_planned'; readonly at: string; readonly id: WorktreeId; readonly operation: PlannedPullRequestOperation }
  | { readonly kind: 'worktree_pull_request_completed'; readonly at: string; readonly id: WorktreeId; readonly operationId: string; readonly delivery: DeliverySummary }
  | { readonly kind: 'worktree_conclude_planned'; readonly at: string; readonly id: WorktreeId; readonly operation: PlannedConcludeOperation }
  | { readonly kind: 'worktree_retained'; readonly at: string; readonly id: WorktreeId; readonly operationId?: string; readonly changes: WorktreeChanges; readonly changedFromInitial: boolean; readonly headCommit: string }
  | { readonly kind: 'worktree_removed'; readonly at: string; readonly id: WorktreeId; readonly operationId?: string; readonly changes: WorktreeChanges; readonly changedFromInitial: boolean; readonly headCommit: string }
  | { readonly kind: 'worktree_recovery_needed'; readonly at: string; readonly id: WorktreeId; readonly reason: string }

export interface JournalProjection {
  readonly record: WorktreeRecord
  readonly state: WorktreeState
  readonly updatedAt: string
  readonly lastChanges?: WorktreeChanges
  readonly lastHeadCommit?: string
  readonly snapshot?: SnapshotArtifact
  readonly initialStateDigest?: string
  readonly lastChangedFromInitial?: boolean
  readonly pendingConclude: PlannedConcludeOperation | undefined
  readonly activeLeases: ReadonlyMap<string, WorktreeLease>
  readonly pendingArchive: PlannedArchiveOperation | undefined
  readonly archiveArtifact: ArchiveArtifact | undefined
  readonly pendingRestore: string | undefined
  readonly lastValidation: ValidationSummary | undefined
  readonly pendingCommit: PlannedCommitOperation | undefined
  readonly pendingBranch: PlannedBranchOperation | undefined
  readonly lastBranch: string | null | undefined
  readonly pendingHandoff: PlannedHandoffOperation | undefined
  readonly handoffArtifact: SnapshotArtifact | undefined
  readonly lastDelivery: DeliverySummary | undefined
  readonly pendingMerge: PlannedMergeOperation | undefined
  readonly pendingPush: PlannedPushOperation | undefined
  readonly pendingPullRequest: PlannedPullRequestOperation | undefined
}

export class OperationJournal {
  private readonly mutex: DirectoryMutex

  constructor(private readonly path: string) {
    this.mutex = new DirectoryMutex(`${path}.locks`)
  }

  async append(event: JournalEvent): Promise<void> {
    await this.mutex.withLock('journal', 'journal append', async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const handle = await open(this.path, 'a', 0o600)
      try {
        await handle.write(`${JSON.stringify(event)}\n`, undefined, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
  }

  async project(): Promise<Map<WorktreeId, JournalProjection>> {
    return this.mutex.withLock('journal', 'journal projection', () => this.projectUnlocked())
  }

  private async projectUnlocked(): Promise<Map<WorktreeId, JournalProjection>> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      throw error
    }
    const result = new Map<WorktreeId, JournalProjection>()
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line === undefined || line === '') continue
      let event: JournalEvent
      try {
        event = JSON.parse(line) as JournalEvent
      } catch (error) {
        const isUnterminatedLastLine = index === lines.length - 1 && !text.endsWith('\n')
        if (isUnterminatedLastLine) break
        throw new Error(`invalid worktree journal event at line ${index + 1}`, { cause: error })
      }
      if (event.kind === 'worktree_create_planned') {
        result.set(event.record.id, {
          record: event.record,
          state: 'creating',
          updatedAt: event.at,
          pendingConclude: undefined,
          activeLeases: new Map(),
          pendingArchive: undefined,
          archiveArtifact: undefined,
          pendingRestore: undefined,
          lastValidation: undefined,
          pendingCommit: undefined,
          pendingBranch: undefined,
          lastBranch: undefined,
          pendingHandoff: undefined,
          handoffArtifact: undefined,
          lastDelivery: undefined,
          pendingMerge: undefined,
          pendingPush: undefined,
          pendingPullRequest: undefined,
        })
        continue
      }
      const current = result.get(event.id)
      if (current === undefined) throw new Error(`worktree journal event references unknown id: ${event.id}`)
      switch (event.kind) {
        case 'worktree_snapshot_ready':
          result.set(event.id, { ...current, updatedAt: event.at, snapshot: event.artifact })
          break
        case 'worktree_ready':
          result.set(event.id, {
            ...current,
            state: 'ready',
            updatedAt: event.at,
            initialStateDigest: event.initialStateDigest,
          })
          break
        case 'worktree_lease_acquired': {
          const activeLeases = new Map(current.activeLeases)
          activeLeases.set(event.lease.id, event.lease)
          result.set(event.id, { ...current, updatedAt: event.at, activeLeases })
          break
        }
        case 'worktree_lease_released': {
          const activeLeases = new Map(current.activeLeases)
          activeLeases.delete(event.leaseId)
          result.set(event.id, { ...current, updatedAt: event.at, activeLeases })
          break
        }
        case 'worktree_archive_planned':
          result.set(event.id, { ...current, updatedAt: event.at, pendingArchive: event.operation })
          break
        case 'worktree_archive_artifact_ready':
          result.set(event.id, { ...current, updatedAt: event.at, archiveArtifact: event.artifact })
          break
        case 'worktree_archived': {
          const planned = current.pendingArchive
          if (planned === undefined || planned.operationId !== event.operationId) {
            throw new Error(`archive completion has no matching plan for worktree ${event.id}`)
          }
          result.set(event.id, {
            ...current,
            state: 'archived',
            updatedAt: event.at,
            pendingArchive: undefined,
            lastChanges: planned.changes,
            lastHeadCommit: planned.headCommit,
            lastChangedFromInitial: planned.changedFromInitial,
            lastBranch: planned.branch,
          })
          break
        }
        case 'worktree_restore_planned':
          result.set(event.id, { ...current, updatedAt: event.at, pendingRestore: event.operationId })
          break
        case 'worktree_restored':
          result.set(event.id, {
            ...current,
            state: 'ready',
            updatedAt: event.at,
            pendingRestore: undefined,
          })
          break
        case 'worktree_validation_completed':
          result.set(event.id, { ...current, updatedAt: event.at, lastValidation: event.validation })
          break
        case 'worktree_commit_planned':
          result.set(event.id, { ...current, updatedAt: event.at, pendingCommit: event.operation })
          break
        case 'worktree_commit_completed': {
          const planned = current.pendingCommit
          if (planned === undefined || planned.operationId !== event.operationId) {
            throw new Error(`commit completion has no matching plan for worktree ${event.id}`)
          }
          result.set(event.id, {
            ...current,
            updatedAt: event.at,
            pendingCommit: undefined,
            lastDelivery: event.delivery,
          })
          break
        }
        case 'worktree_branch_planned':
          result.set(event.id, { ...current, updatedAt: event.at, pendingBranch: event.operation })
          break
        case 'worktree_branch_completed': {
          const planned = current.pendingBranch
          if (planned === undefined || planned.operationId !== event.operationId || planned.name !== event.branch) {
            throw new Error(`branch completion has no matching plan for worktree ${event.id}`)
          }
          result.set(event.id, {
            ...current,
            updatedAt: event.at,
            pendingBranch: undefined,
            lastBranch: event.branch,
          })
          break
        }
        case 'worktree_handoff_planned':
          result.set(event.id, { ...current, updatedAt: event.at, pendingHandoff: event.operation })
          break
        case 'worktree_handoff_artifact_ready':
          result.set(event.id, { ...current, updatedAt: event.at, handoffArtifact: event.artifact })
          break
        case 'worktree_handoff_completed': {
          const planned = current.pendingHandoff
          if (planned === undefined || planned.operationId !== event.operationId) {
            throw new Error(`handoff completion has no matching plan for worktree ${event.id}`)
          }
          result.set(event.id, {
            ...current,
            state: 'integrated',
            updatedAt: event.at,
            pendingHandoff: undefined,
            lastDelivery: event.delivery,
          })
          break
        }
        case 'worktree_merge_planned':
          result.set(event.id, { ...current, updatedAt: event.at, pendingMerge: event.operation })
          break
        case 'worktree_merge_completed': {
          const planned = current.pendingMerge
          if (planned === undefined || planned.operationId !== event.operationId) {
            throw new Error(`merge completion has no matching plan for worktree ${event.id}`)
          }
          result.set(event.id, {
            ...current,
            state: 'integrated',
            updatedAt: event.at,
            pendingMerge: undefined,
            lastDelivery: event.delivery,
          })
          break
        }
        case 'worktree_push_planned':
          result.set(event.id, { ...current, updatedAt: event.at, pendingPush: event.operation })
          break
        case 'worktree_push_completed': {
          const planned = current.pendingPush
          if (planned === undefined || planned.operationId !== event.operationId) {
            throw new Error(`push completion has no matching plan for worktree ${event.id}`)
          }
          result.set(event.id, {
            ...current,
            state: 'published',
            updatedAt: event.at,
            pendingPush: undefined,
            lastDelivery: event.delivery,
          })
          break
        }
        case 'worktree_pull_request_planned':
          result.set(event.id, { ...current, updatedAt: event.at, pendingPullRequest: event.operation })
          break
        case 'worktree_pull_request_completed': {
          const planned = current.pendingPullRequest
          if (planned === undefined || planned.operationId !== event.operationId) {
            throw new Error(`pull request completion has no matching plan for worktree ${event.id}`)
          }
          result.set(event.id, {
            ...current,
            state: 'published',
            updatedAt: event.at,
            pendingPullRequest: undefined,
            lastDelivery: event.delivery,
          })
          break
        }
        case 'worktree_conclude_planned':
          result.set(event.id, {
            ...current,
            updatedAt: event.at,
            pendingConclude: event.operation,
          })
          break
        case 'worktree_retained':
          result.set(event.id, {
            ...current,
            state: 'retained',
            updatedAt: event.at,
            lastChanges: event.changes,
            lastHeadCommit: event.headCommit,
            lastChangedFromInitial: event.changedFromInitial,
            pendingConclude: undefined,
          })
          break
        case 'worktree_removed':
          result.set(event.id, {
            ...current,
            state: 'removed',
            updatedAt: event.at,
            lastChanges: event.changes,
            lastHeadCommit: event.headCommit,
            lastChangedFromInitial: event.changedFromInitial,
            pendingConclude: undefined,
          })
          break
        case 'worktree_recovery_needed':
          result.set(event.id, { ...current, state: 'recovery-needed', updatedAt: event.at })
          break
      }
    }
    return result
  }
}
