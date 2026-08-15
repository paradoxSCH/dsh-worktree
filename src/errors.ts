import type { WorktreeId } from './types.js'

/** Base error for caller-actionable worktree lifecycle failures. */
export class WorktreeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'WorktreeError'
  }
}

/** Raised when a durable worktree id is unknown. */
export class WorktreeNotFoundError extends WorktreeError {
  constructor(readonly worktreeId: WorktreeId) {
    super(`unknown managed worktree: ${worktreeId}`, 'WORKTREE_NOT_FOUND')
    this.name = 'WorktreeNotFoundError'
  }
}

/** Raised when an operation would silently destroy repository changes. */
export class WorktreeChangedError extends WorktreeError {
  constructor(readonly worktreeId: WorktreeId) {
    super(`worktree ${worktreeId} contains changes and cannot be removed as clean`, 'WORKTREE_CHANGED')
    this.name = 'WorktreeChangedError'
  }
}

/** Raised when a stale observation token is used for a destructive action. */
export class WorktreeChangedSinceInspectionError extends WorktreeError {
  constructor(readonly worktreeId: WorktreeId) {
    super(`worktree ${worktreeId} changed after it was inspected`, 'WORKTREE_CHANGE_TOKEN_STALE')
    this.name = 'WorktreeChangedSinceInspectionError'
  }
}

export class WorktreeInUseError extends WorktreeError {
  constructor(id: string, leaseCount: number) {
    super(`worktree ${id} still has ${leaseCount} active owner lease(s)`, 'WORKTREE_IN_USE')
    this.name = 'WorktreeInUseError'
  }
}
