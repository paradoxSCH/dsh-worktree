import type { WorktreeChanges } from './types.js';
export interface RepositoryIdentity {
    readonly topLevel: string;
    readonly commonDirectory: string;
    readonly headCommit: string;
}
export interface LinkedWorktree {
    readonly path: string;
    readonly locked: boolean;
    readonly lockReason?: string;
}
export interface GitReview {
    readonly summary: string;
    readonly diff: string;
    readonly untrackedPaths: readonly string[];
    readonly truncated: boolean;
}
export declare class GitCli {
    private runBuffer;
    private run;
    version(cwd: string): Promise<string>;
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
    ignoredAllowlistPaths(repository: string, patterns: readonly string[]): Promise<Buffer>;
    applyStagedPatch(path: string, patch: Buffer): Promise<void>;
    applyWorkingPatch(path: string, patch: Buffer): Promise<void>;
    addLocked(repository: string, path: string, commit: string, reason: string): Promise<void>;
    verify(path: string, expectedCommonDirectory: string): Promise<RepositoryIdentity>;
    changes(path: string, baseCommit: string): Promise<{
        readonly headCommit: string;
        readonly changes: WorktreeChanges;
    }>;
    listLinkedWorktrees(repository: string): Promise<readonly LinkedWorktree[]>;
    review(path: string, baseCommit: string, maxBytes: number): Promise<GitReview>;
    preserveRef(repository: string, ref: string, commit: string): Promise<void>;
    currentBranch(path: string): Promise<string | null>;
    branchCommit(repository: string, name: string): Promise<string | undefined>;
    attachBranch(path: string, name: string, expectedHead: string): Promise<void>;
    private validateBranchName;
    private resolveOptionalCommit;
    unlock(repository: string, path: string): Promise<void>;
    unlockForRemoval(repository: string, path: string): Promise<void>;
    remove(repository: string, path: string, force: boolean): Promise<void>;
    resetHard(path: string, commit: string): Promise<void>;
    stageAll(path: string): Promise<void>;
    commitStaged(path: string, message: string): Promise<string>;
    commitContentDigest(path: string): Promise<string>;
    mergeNoEdit(path: string, sourceCommit: string): Promise<void>;
    abortMerge(path: string): Promise<void>;
    isAncestor(path: string, ancestor: string, descendant: string): Promise<boolean>;
    pushBranch(path: string, remote: string, branch: string): Promise<void>;
    remoteBranchCommit(path: string, remote: string, branch: string): Promise<string | undefined>;
}
//# sourceMappingURL=git.d.ts.map