import type { WorktreeChanges } from './types.js';
export interface RepositoryIdentity {
    readonly topLevel: string;
    readonly commonDirectory: string;
    readonly headCommit: string;
}
export declare class GitCli {
    private runBuffer;
    private run;
    private runWithInput;
    identify(repository: string): Promise<RepositoryIdentity>;
    resolveCommit(repository: string, ref: string): Promise<string>;
    resolveRemoteCommit(repository: string, remote: string, ref?: string): Promise<{
        readonly commit: string;
        readonly ref: string;
    }>;
    fetchRemoteCommit(repository: string, remote: string, sourceRef: string, destinationRef: string, expectedCommit: string): Promise<void>;
    stagedPatch(repository: string, baseCommit: string): Promise<Buffer>;
    workingPatch(repository: string): Promise<Buffer>;
    untrackedPaths(repository: string): Promise<Buffer>;
    applyStagedPatch(path: string, patch: Buffer): Promise<void>;
    applyWorkingPatch(path: string, patch: Buffer): Promise<void>;
    addLocked(repository: string, path: string, commit: string, reason: string): Promise<void>;
    verify(path: string, expectedCommonDirectory: string): Promise<RepositoryIdentity>;
    changes(path: string, baseCommit: string): Promise<{
        readonly headCommit: string;
        readonly changes: WorktreeChanges;
    }>;
    unlock(repository: string, path: string): Promise<void>;
    remove(repository: string, path: string, force: boolean): Promise<void>;
}
//# sourceMappingURL=git.d.ts.map