import { open, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LifetimePolicy, WorktreeChanges, WorktreeId, WorktreeState } from './types.js'
import type { SnapshotArtifact } from './snapshot.js'

export interface WorktreeRecord {
  readonly id: WorktreeId
  readonly operationId: string
  readonly repository: string
  readonly commonDirectory: string
  readonly path: string
  readonly baseCommit: string
  readonly lifetime: LifetimePolicy
  readonly sourceKind: 'head' | 'fresh' | 'working-state'
  readonly createdAt: string
}

export type JournalEvent =
  | { readonly kind: 'worktree_create_planned'; readonly at: string; readonly record: WorktreeRecord }
  | { readonly kind: 'worktree_snapshot_ready'; readonly at: string; readonly id: WorktreeId; readonly artifact: SnapshotArtifact }
  | { readonly kind: 'worktree_ready'; readonly at: string; readonly id: WorktreeId; readonly initialStateDigest: string }
  | { readonly kind: 'worktree_retained'; readonly at: string; readonly id: WorktreeId; readonly changes: WorktreeChanges; readonly changedFromInitial: boolean; readonly headCommit: string }
  | { readonly kind: 'worktree_removed'; readonly at: string; readonly id: WorktreeId; readonly changes: WorktreeChanges; readonly changedFromInitial: boolean; readonly headCommit: string }
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
}

export class OperationJournal {
  constructor(private readonly path: string) {}

  async append(event: JournalEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const handle = await open(this.path, 'a', 0o600)
    try {
      await handle.write(`${JSON.stringify(event)}\n`, undefined, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async project(): Promise<Map<WorktreeId, JournalProjection>> {
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
        case 'worktree_retained':
          result.set(event.id, {
            ...current,
            state: 'retained',
            updatedAt: event.at,
            lastChanges: event.changes,
            lastHeadCommit: event.headCommit,
            lastChangedFromInitial: event.changedFromInitial,
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
