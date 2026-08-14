/** Base error for caller-actionable worktree lifecycle failures. */
export class WorktreeError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'WorktreeError';
    }
}
/** Raised when a durable worktree id is unknown. */
export class WorktreeNotFoundError extends WorktreeError {
    worktreeId;
    constructor(worktreeId) {
        super(`unknown managed worktree: ${worktreeId}`, 'WORKTREE_NOT_FOUND');
        this.worktreeId = worktreeId;
        this.name = 'WorktreeNotFoundError';
    }
}
/** Raised when an operation would silently destroy repository changes. */
export class WorktreeChangedError extends WorktreeError {
    worktreeId;
    constructor(worktreeId) {
        super(`worktree ${worktreeId} contains changes and cannot be removed as clean`, 'WORKTREE_CHANGED');
        this.worktreeId = worktreeId;
        this.name = 'WorktreeChangedError';
    }
}
/** Raised when a stale observation token is used for a destructive action. */
export class WorktreeChangedSinceInspectionError extends WorktreeError {
    worktreeId;
    constructor(worktreeId) {
        super(`worktree ${worktreeId} changed after it was inspected`, 'WORKTREE_CHANGE_TOKEN_STALE');
        this.worktreeId = worktreeId;
        this.name = 'WorktreeChangedSinceInspectionError';
    }
}
//# sourceMappingURL=errors.js.map