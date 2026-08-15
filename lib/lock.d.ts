export interface DirectoryMutexOptions {
    readonly timeoutMs?: number;
    readonly retryMs?: number;
    readonly staleAfterMs?: number;
}
/**
 * Cross-process mutex implemented with atomic directory creation. Lock
 * directories contain only one identity file and are removed without a
 * recursive filesystem operation.
 */
export declare class DirectoryMutex {
    private readonly root;
    private readonly timeoutMs;
    private readonly retryMs;
    private readonly staleAfterMs;
    constructor(root: string, options?: DirectoryMutexOptions);
    withLock<T>(identity: string, purpose: string, operation: () => Promise<T>): Promise<T>;
    private acquire;
    private removeStale;
}
//# sourceMappingURL=lock.d.ts.map