import type { GitCli } from './git.js';
import type { WorktreeId } from './types.js';
/** Durable reference to one captured parent working state. */
export interface SnapshotArtifact {
    readonly directory: string;
    readonly digest: string;
}
export interface SnapshotCaptureOptions {
    readonly ignoredPatterns?: readonly string[];
    readonly allowSensitiveIgnored?: boolean;
}
export declare class SourceSnapshotter {
    private readonly root;
    private readonly git;
    constructor(root: string, git: GitCli);
    capture(repository: string, id: WorktreeId, baseCommit: string, artifactKey?: string, options?: SnapshotCaptureOptions): Promise<SnapshotArtifact>;
    load(id: WorktreeId, baseCommit: string, artifactKey: string): Promise<SnapshotArtifact | undefined>;
    fingerprint(repository: string, baseCommit: string, options?: SnapshotCaptureOptions): Promise<string>;
    emptyFingerprint(): string;
    replay(artifact: SnapshotArtifact, id: WorktreeId, baseCommit: string, worktreePath: string): Promise<void>;
    remove(artifact: SnapshotArtifact): Promise<void>;
    removeReplayedUntrackedFiles(artifact: SnapshotArtifact, id: WorktreeId, baseCommit: string, destinationRoot: string): Promise<void>;
    private captureMaterial;
}
//# sourceMappingURL=snapshot.d.ts.map