import type { ConcludeWorktreeRequest, CreateWorktreeRequest, WorktreeId, WorktreeManager, WorktreeManagerOptions, WorktreeRecoveryReport, WorktreeView } from './types.js';
export declare class LocalWorktreeManager implements WorktreeManager {
    private readonly options;
    private readonly git;
    private readonly journal;
    private readonly snapshotter;
    private closed;
    private operationTail;
    constructor(options: WorktreeManagerOptions);
    private serialized;
    create(request: CreateWorktreeRequest): Promise<WorktreeView>;
    inspect(id: WorktreeId): Promise<WorktreeView>;
    private inspectUnserialized;
    conclude(request: ConcludeWorktreeRequest): Promise<WorktreeView>;
    list(): Promise<readonly WorktreeView[]>;
    recover(): Promise<WorktreeRecoveryReport>;
    close(): Promise<void>;
    private projection;
    private boundary;
    private recoverOne;
    private removedView;
    private inactiveView;
}
//# sourceMappingURL=manager.d.ts.map