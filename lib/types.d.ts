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
    readonly ignoredPatterns?: readonly string[];
    readonly allowSensitiveIgnored?: boolean;
};
/** How long the product keeps a worktree without an explicit user decision. */
export type LifetimePolicy = 'ephemeral' | 'managed' | 'permanent';
/** Durable lifecycle states projected from the operation journal. */
export type WorktreeState = 'creating' | 'ready' | 'retained' | 'integrated' | 'published' | 'archived' | 'removed' | 'recovery-needed';
/** Observable repository changes relative to the worktree's immutable base commit. */
export interface WorktreeChanges {
    readonly dirty: boolean;
    readonly stagedFileCount: number;
    readonly unstagedFileCount: number;
    readonly untrackedFileCount: number;
    readonly newCommitCount: number;
}
export type WorktreeOwnerKind = 'session' | 'subagent-run' | 'continuable-child' | 'workflow-task' | 'external';
/** Durable identity of a consumer that may still write to a worktree. */
export interface WorktreeOwner {
    readonly kind: WorktreeOwnerKind;
    readonly id: string;
    readonly label?: string;
    readonly parentSessionId?: string;
}
export interface WorktreeLease {
    readonly id: string;
    readonly worktreeId: WorktreeId;
    readonly owner: WorktreeOwner;
    readonly acquiredAt: string;
}
export interface WorktreeReview {
    readonly worktreeId: WorktreeId;
    readonly changeToken: string;
    readonly summary: string;
    readonly diff: string;
    readonly untrackedPaths: readonly string[];
    readonly truncated: boolean;
}
export interface ValidationCommand {
    readonly name: string;
    readonly executable: string;
    readonly args?: readonly string[];
    readonly timeoutMs?: number;
}
export interface ValidationCommandResult {
    readonly name: string;
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly durationMs: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated: boolean;
}
export interface ValidationSummary {
    readonly id: string;
    readonly passed: boolean;
    readonly completedAt: string;
    readonly commands: readonly {
        readonly name: string;
        readonly exitCode: number | null;
        readonly signal: NodeJS.Signals | null;
        readonly durationMs: number;
    }[];
}
export interface ValidationResult extends ValidationSummary {
    readonly results: readonly ValidationCommandResult[];
    readonly changeToken: string;
}
export interface DeliverySummary {
    readonly id: string;
    readonly kind: 'commit' | 'handoff' | 'merge' | 'push' | 'pull-request';
    readonly target: string;
    readonly completedAt: string;
    readonly sourceHeadCommit: string;
    readonly url?: string;
}
export interface PullRequestEnsureRequest {
    readonly worktreePath: string;
    readonly remote: string;
    readonly headBranch: string;
    readonly baseBranch?: string;
    readonly title: string;
    readonly body: string;
}
export interface PullRequestEnsureResult {
    readonly url: string;
}
/** External forge seam. Implementations must find an existing PR before creating one. */
export interface PullRequestPublisher {
    readonly kind: string;
    ensure(request: PullRequestEnsureRequest): Promise<PullRequestEnsureResult>;
}
/** Stable caller-facing projection of one managed worktree. */
export interface WorktreeView {
    readonly id: WorktreeId;
    readonly state: WorktreeState;
    readonly path: string;
    readonly repository: string;
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly branch: string | null;
    readonly lifetime: LifetimePolicy;
    readonly changes: WorktreeChanges;
    /** Whether the worktree differs from the exact state published at creation. */
    readonly changedFromInitial: boolean;
    readonly changeToken: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly activeLeases: readonly WorktreeLease[];
    readonly lastValidation: ValidationSummary | undefined;
    readonly lastDelivery: DeliverySummary | undefined;
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
export type WorktreeActionRequest = {
    readonly id: WorktreeId;
    readonly action: 'archive';
    readonly changeToken: string;
} | {
    readonly id: WorktreeId;
    readonly action: 'restore';
} | {
    readonly id: WorktreeId;
    readonly action: 'commit';
    readonly message: string;
    readonly changeToken: string;
} | {
    readonly id: WorktreeId;
    readonly action: 'create-branch';
    readonly name: string;
    readonly changeToken: string;
} | {
    readonly id: WorktreeId;
    readonly action: 'handoff';
    readonly targetPath: string;
    readonly changeToken: string;
} | {
    readonly id: WorktreeId;
    readonly action: 'merge';
    readonly targetPath: string;
    readonly changeToken: string;
} | {
    readonly id: WorktreeId;
    readonly action: 'push';
    readonly remote: string;
    readonly changeToken: string;
} | {
    readonly id: WorktreeId;
    readonly action: 'pull-request';
    readonly remote: string;
    readonly baseBranch?: string;
    readonly title: string;
    readonly body: string;
    readonly changeToken: string;
};
/** Public worktree lifecycle interface used by DSH tools and user interfaces. */
export interface WorktreeManager {
    /** Create and publish a fully verified worktree. */
    create(request: CreateWorktreeRequest): Promise<WorktreeView>;
    /** Observe current Git state and produce a destructive-action token. */
    inspect(id: WorktreeId): Promise<WorktreeView>;
    /** Register a durable writer/consumer. Cleanup is blocked until release. */
    acquireLease(id: WorktreeId, owner: WorktreeOwner): Promise<WorktreeLease>;
    /** Idempotently release one durable owner lease. */
    releaseLease(id: WorktreeId, leaseId: string): Promise<void>;
    /** Execute a durable high-level lifecycle action. */
    act(request: WorktreeActionRequest): Promise<WorktreeView>;
    review(id: WorktreeId, maxBytes?: number): Promise<WorktreeReview>;
    validate(id: WorktreeId, commands: readonly ValidationCommand[]): Promise<ValidationResult>;
    /** Apply one explicit post-run lifecycle decision. */
    conclude(request: ConcludeWorktreeRequest): Promise<WorktreeView>;
    /** List durable records, including retained and removed resources. */
    list(): Promise<readonly WorktreeView[]>;
    /** Reconcile incomplete journal operations with Git and the filesystem. */
    recover(): Promise<WorktreeRecoveryReport>;
    /** Read-only environment and durable-state diagnostics. */
    doctor(): Promise<WorktreeDoctorReport>;
    /** Stop accepting operations and wait for in-flight journal writes. */
    close(): Promise<void>;
}
/** Configuration for the local durable implementation. */
export interface WorktreeManagerOptions {
    readonly managedRoot: string;
    readonly journalPath: string;
    /** Test/host drive hook invoked after named durable side-effect boundaries. */
    readonly onBoundary?: (boundary: WorktreeBoundary, id: WorktreeId) => Promise<void>;
    readonly pullRequestPublisher?: PullRequestPublisher;
}
export type WorktreeBoundary = 'after-create-planned' | 'after-snapshot-ready' | 'after-worktree-added' | 'after-snapshot-replayed' | 'after-ready' | 'after-conclude-planned' | 'after-unlock-for-removal' | 'after-worktree-removed' | 'after-conclude-completed' | 'after-archive-planned' | 'after-archive-artifact-ready' | 'after-archive-removed' | 'after-archived' | 'after-restore-planned' | 'after-restore-added' | 'after-restored' | 'after-commit-planned' | 'after-commit-staged' | 'after-commit-created' | 'after-commit-completed' | 'after-branch-planned' | 'after-branch-attached' | 'after-branch-completed' | 'after-handoff-planned' | 'after-handoff-artifact-ready' | 'after-handoff-applied' | 'after-handoff-completed' | 'after-merge-planned' | 'after-merge-committed' | 'after-merge-completed' | 'after-push-planned' | 'after-push-updated-remote' | 'after-push-completed' | 'after-pull-request-planned' | 'after-pull-request-pushed' | 'after-pull-request-created' | 'after-pull-request-completed';
export interface WorktreeRecoveryReport {
    readonly recovered: readonly WorktreeId[];
    readonly healthy: readonly WorktreeId[];
    readonly manual: readonly {
        readonly id: WorktreeId;
        readonly reason: string;
    }[];
    readonly orphaned: readonly {
        readonly repository: string;
        readonly path: string;
        readonly reason: string;
    }[];
}
export interface WorktreeDoctorReport {
    readonly status: 'ok' | 'attention';
    readonly gitVersion: string;
    readonly nodeVersion: string;
    readonly managedRoot: string;
    readonly journalPath: string;
    readonly recordCount: number;
    readonly materializedCount: number;
    readonly activeLeaseCount: number;
    readonly pending: readonly {
        readonly id: WorktreeId;
        readonly operations: readonly string[];
    }[];
    readonly problems: readonly {
        readonly id?: WorktreeId;
        readonly message: string;
    }[];
}
//# sourceMappingURL=types.d.ts.map