import type { DeliverySummary, LifetimePolicy, ValidationSummary, WorktreeChanges, WorktreeId, WorktreeLease, WorktreeState } from './types.js';
import type { SnapshotArtifact } from './snapshot.js';
export interface WorktreeRecord {
    readonly formatVersion: 1;
    readonly id: WorktreeId;
    readonly operationId: string;
    readonly repository: string;
    readonly commonDirectory: string;
    readonly path: string;
    readonly baseCommit: string;
    readonly lifetime: LifetimePolicy;
    readonly sourceKind: 'head' | 'fresh' | 'working-state';
    readonly ignoredPatterns: readonly string[];
    readonly allowSensitiveIgnored: boolean;
    readonly createdAt: string;
}
export type ConcludeOperationKind = 'retain' | 'remove-clean' | 'discard';
export interface PlannedConcludeOperation {
    readonly operationId: string;
    readonly action: ConcludeOperationKind;
    readonly changeToken: string;
    readonly changes: WorktreeChanges;
    readonly changedFromInitial: boolean;
    readonly headCommit: string;
}
export interface ArchiveArtifact {
    readonly ref: string;
    readonly headCommit: string;
    readonly snapshot: SnapshotArtifact | undefined;
}
export interface PlannedArchiveOperation {
    readonly operationId: string;
    readonly changeToken: string;
    readonly headCommit: string;
    readonly changes: WorktreeChanges;
    readonly changedFromInitial: boolean;
    readonly branch: string | null;
}
export interface PlannedBranchOperation {
    readonly operationId: string;
    readonly name: string;
    readonly changeToken: string;
    readonly headCommit: string;
}
export interface PlannedCommitOperation {
    readonly operationId: string;
    readonly message: string;
    readonly changeToken: string;
    readonly previousHeadCommit: string;
    readonly contentDigest: string;
}
export interface PlannedHandoffOperation {
    readonly operationId: string;
    readonly targetPath: string;
    readonly changeToken: string;
    readonly baseCommit: string;
    readonly headCommit: string;
}
export interface PlannedMergeOperation {
    readonly operationId: string;
    readonly targetPath: string;
    readonly targetBranch: string;
    readonly targetHeadCommit: string;
    readonly sourceHeadCommit: string;
    readonly changeToken: string;
}
export interface PlannedPushOperation {
    readonly operationId: string;
    readonly remote: string;
    readonly branch: string;
    readonly headCommit: string;
    readonly changeToken: string;
}
export interface PlannedPullRequestOperation {
    readonly operationId: string;
    readonly remote: string;
    readonly branch: string;
    readonly baseBranch: string | undefined;
    readonly title: string;
    readonly body: string;
    readonly headCommit: string;
    readonly changeToken: string;
}
export type JournalEvent = {
    readonly kind: 'worktree_create_planned';
    readonly at: string;
    readonly record: WorktreeRecord;
} | {
    readonly kind: 'worktree_snapshot_ready';
    readonly at: string;
    readonly id: WorktreeId;
    readonly artifact: SnapshotArtifact;
} | {
    readonly kind: 'worktree_ready';
    readonly at: string;
    readonly id: WorktreeId;
    readonly initialStateDigest: string;
} | {
    readonly kind: 'worktree_lease_acquired';
    readonly at: string;
    readonly id: WorktreeId;
    readonly lease: WorktreeLease;
} | {
    readonly kind: 'worktree_lease_released';
    readonly at: string;
    readonly id: WorktreeId;
    readonly leaseId: string;
} | {
    readonly kind: 'worktree_archive_planned';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operation: PlannedArchiveOperation;
} | {
    readonly kind: 'worktree_archive_artifact_ready';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operationId: string;
    readonly artifact: ArchiveArtifact;
} | {
    readonly kind: 'worktree_archived';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operationId: string;
} | {
    readonly kind: 'worktree_restore_planned';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operationId: string;
} | {
    readonly kind: 'worktree_restored';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operationId: string;
} | {
    readonly kind: 'worktree_validation_completed';
    readonly at: string;
    readonly id: WorktreeId;
    readonly validation: ValidationSummary;
} | {
    readonly kind: 'worktree_commit_planned';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operation: PlannedCommitOperation;
} | {
    readonly kind: 'worktree_commit_completed';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operationId: string;
    readonly delivery: DeliverySummary;
} | {
    readonly kind: 'worktree_branch_planned';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operation: PlannedBranchOperation;
} | {
    readonly kind: 'worktree_branch_completed';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operationId: string;
    readonly branch: string;
} | {
    readonly kind: 'worktree_handoff_planned';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operation: PlannedHandoffOperation;
} | {
    readonly kind: 'worktree_handoff_artifact_ready';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operationId: string;
    readonly artifact: SnapshotArtifact;
} | {
    readonly kind: 'worktree_handoff_completed';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operationId: string;
    readonly delivery: DeliverySummary;
} | {
    readonly kind: 'worktree_merge_planned';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operation: PlannedMergeOperation;
} | {
    readonly kind: 'worktree_merge_completed';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operationId: string;
    readonly delivery: DeliverySummary;
} | {
    readonly kind: 'worktree_push_planned';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operation: PlannedPushOperation;
} | {
    readonly kind: 'worktree_push_completed';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operationId: string;
    readonly delivery: DeliverySummary;
} | {
    readonly kind: 'worktree_pull_request_planned';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operation: PlannedPullRequestOperation;
} | {
    readonly kind: 'worktree_pull_request_completed';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operationId: string;
    readonly delivery: DeliverySummary;
} | {
    readonly kind: 'worktree_conclude_planned';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operation: PlannedConcludeOperation;
} | {
    readonly kind: 'worktree_retained';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operationId?: string;
    readonly changes: WorktreeChanges;
    readonly changedFromInitial: boolean;
    readonly headCommit: string;
} | {
    readonly kind: 'worktree_removed';
    readonly at: string;
    readonly id: WorktreeId;
    readonly operationId?: string;
    readonly changes: WorktreeChanges;
    readonly changedFromInitial: boolean;
    readonly headCommit: string;
} | {
    readonly kind: 'worktree_recovery_needed';
    readonly at: string;
    readonly id: WorktreeId;
    readonly reason: string;
};
export interface JournalProjection {
    readonly record: WorktreeRecord;
    readonly state: WorktreeState;
    readonly updatedAt: string;
    readonly lastChanges?: WorktreeChanges;
    readonly lastHeadCommit?: string;
    readonly snapshot?: SnapshotArtifact;
    readonly initialStateDigest?: string;
    readonly lastChangedFromInitial?: boolean;
    readonly pendingConclude: PlannedConcludeOperation | undefined;
    readonly activeLeases: ReadonlyMap<string, WorktreeLease>;
    readonly pendingArchive: PlannedArchiveOperation | undefined;
    readonly archiveArtifact: ArchiveArtifact | undefined;
    readonly pendingRestore: string | undefined;
    readonly lastValidation: ValidationSummary | undefined;
    readonly pendingCommit: PlannedCommitOperation | undefined;
    readonly pendingBranch: PlannedBranchOperation | undefined;
    readonly lastBranch: string | null | undefined;
    readonly pendingHandoff: PlannedHandoffOperation | undefined;
    readonly handoffArtifact: SnapshotArtifact | undefined;
    readonly lastDelivery: DeliverySummary | undefined;
    readonly pendingMerge: PlannedMergeOperation | undefined;
    readonly pendingPush: PlannedPushOperation | undefined;
    readonly pendingPullRequest: PlannedPullRequestOperation | undefined;
}
export declare class OperationJournal {
    private readonly path;
    private readonly mutex;
    constructor(path: string);
    append(event: JournalEvent): Promise<void>;
    project(): Promise<Map<WorktreeId, JournalProjection>>;
    private projectUnlocked;
}
//# sourceMappingURL=journal.d.ts.map