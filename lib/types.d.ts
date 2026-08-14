/** Opaque identifier for one managed worktree. */
export type WorktreeId = string & {
    readonly __worktreeId: unique symbol;
};
/** The repository state from which a worktree is created. */
export type SourcePolicy = {
    readonly kind: 'head';
    readonly ref?: string;
} | {
    readonly kind: 'fresh';
    readonly remote?: string;
    readonly ref?: string;
} | {
    readonly kind: 'working-state';
    readonly includeIgnored: 'allowlist';
};
/** How long the product keeps a worktree without an explicit user decision. */
export type LifetimePolicy = 'ephemeral' | 'managed' | 'permanent';
/** Durable lifecycle states projected from the operation journal. */
export type WorktreeState = 'creating' | 'ready' | 'retained' | 'removed' | 'recovery-needed';
/** Observable repository changes relative to the worktree's immutable base commit. */
export interface WorktreeChanges {
    readonly dirty: boolean;
    readonly stagedFileCount: number;
    readonly unstagedFileCount: number;
    readonly untrackedFileCount: number;
    readonly newCommitCount: number;
}
/** Stable caller-facing projection of one managed worktree. */
export interface WorktreeView {
    readonly id: WorktreeId;
    readonly state: WorktreeState;
    readonly path: string;
    readonly repository: string;
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly lifetime: LifetimePolicy;
    readonly changes: WorktreeChanges;
    /** Whether the worktree differs from the exact state published at creation. */
    readonly changedFromInitial: boolean;
    readonly changeToken: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}
/** Request to create a managed worktree. */
export interface CreateWorktreeRequest {
    readonly repository: string;
    readonly source: SourcePolicy;
    readonly lifetime: LifetimePolicy;
}
/** A safe lifecycle decision after a run stops. */
export type ConcludeWorktreeRequest = {
    readonly id: WorktreeId;
    readonly action: 'remove-clean';
} | {
    readonly id: WorktreeId;
    readonly action: 'retain';
} | {
    readonly id: WorktreeId;
    readonly action: 'discard';
    readonly changeToken: string;
    readonly confirmation: 'discard';
};
/** Public worktree lifecycle interface used by DSH tools and user interfaces. */
export interface WorktreeManager {
    /** Create and publish a fully verified worktree. */
    create(request: CreateWorktreeRequest): Promise<WorktreeView>;
    /** Observe current Git state and produce a destructive-action token. */
    inspect(id: WorktreeId): Promise<WorktreeView>;
    /** Apply one explicit post-run lifecycle decision. */
    conclude(request: ConcludeWorktreeRequest): Promise<WorktreeView>;
    /** List durable records, including retained and removed resources. */
    list(): Promise<readonly WorktreeView[]>;
    /** Reconcile incomplete journal operations with Git and the filesystem. */
    recover(): Promise<WorktreeRecoveryReport>;
    /** Stop accepting operations and wait for in-flight journal writes. */
    close(): Promise<void>;
}
/** Configuration for the local durable implementation. */
export interface WorktreeManagerOptions {
    readonly managedRoot: string;
    readonly journalPath: string;
    /** Test/host drive hook invoked after named durable side-effect boundaries. */
    readonly onBoundary?: (boundary: WorktreeBoundary, id: WorktreeId) => Promise<void>;
}
export type WorktreeBoundary = 'after-create-planned' | 'after-snapshot-ready' | 'after-worktree-added' | 'after-snapshot-replayed' | 'after-ready';
export interface WorktreeRecoveryReport {
    readonly recovered: readonly WorktreeId[];
    readonly manual: readonly {
        readonly id: WorktreeId;
        readonly reason: string;
    }[];
}
//# sourceMappingURL=types.d.ts.map