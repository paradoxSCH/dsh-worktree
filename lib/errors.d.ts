import type { WorktreeId } from './types.js';
/** Base error for caller-actionable worktree lifecycle failures. */
export declare class WorktreeError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/** Raised when a durable worktree id is unknown. */
export declare class WorktreeNotFoundError extends WorktreeError {
    readonly worktreeId: WorktreeId;
    constructor(worktreeId: WorktreeId);
}
/** Raised when an operation would silently destroy repository changes. */
export declare class WorktreeChangedError extends WorktreeError {
    readonly worktreeId: WorktreeId;
    constructor(worktreeId: WorktreeId);
}
/** Raised when a stale observation token is used for a destructive action. */
export declare class WorktreeChangedSinceInspectionError extends WorktreeError {
    readonly worktreeId: WorktreeId;
    constructor(worktreeId: WorktreeId);
}
export declare class WorktreeInUseError extends WorktreeError {
    constructor(id: string, leaseCount: number);
}
//# sourceMappingURL=errors.d.ts.map