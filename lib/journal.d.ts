import type { LifetimePolicy, WorktreeChanges, WorktreeId, WorktreeState } from './types.js';
import type { SnapshotArtifact } from './snapshot.js';
export interface WorktreeRecord {
    readonly id: WorktreeId;
    readonly operationId: string;
    readonly repository: string;
    readonly commonDirectory: string;
    readonly path: string;
    readonly baseCommit: string;
    readonly lifetime: LifetimePolicy;
    readonly sourceKind: 'head' | 'fresh' | 'working-state';
    readonly createdAt: string;
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
    readonly kind: 'worktree_retained';
    readonly at: string;
    readonly id: WorktreeId;
    readonly changes: WorktreeChanges;
    readonly changedFromInitial: boolean;
    readonly headCommit: string;
} | {
    readonly kind: 'worktree_removed';
    readonly at: string;
    readonly id: WorktreeId;
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
}
export declare class OperationJournal {
    private readonly path;
    constructor(path: string);
    append(event: JournalEvent): Promise<void>;
    project(): Promise<Map<WorktreeId, JournalProjection>>;
}
//# sourceMappingURL=journal.d.ts.map