import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { LifetimePolicy, WorktreeManager, WorktreeManagerOptions } from './types.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Durable Git worktree lifecycle shared by providers, tools, and UI adapters. */
        worktrees: WorktreeManager;
    }
}
export declare const name = "dsh-worktree";
export declare const inject: string[];
export interface Config {
    providerName: string;
    managedRoot: string;
    journalPath: string;
    sourceMode: 'head' | 'working-state' | 'fresh';
    sourceRemote?: string;
    sourceRef?: string;
    lifetime: LifetimePolicy;
}
export declare const Config: z<Config>;
/** Register the shared manager and DSH subagent provider. */
export declare function apply(ctx: Context, config: Config): Promise<void>;
export { WorktreeChangedError, WorktreeChangedSinceInspectionError, WorktreeError, WorktreeNotFoundError, } from './errors.js';
export { LocalWorktreeManager } from './manager.js';
export { WorktreeSubagentProvider } from './provider.js';
export type { InProcessRunStarter, WorktreeProviderPolicy } from './provider.js';
export type { ConcludeWorktreeRequest, CreateWorktreeRequest, LifetimePolicy, SourcePolicy, WorktreeChanges, WorktreeBoundary, WorktreeId, WorktreeManager, WorktreeManagerOptions, WorktreeRecoveryReport, WorktreeState, WorktreeView, } from './types.js';
/**
 * Create the durable local worktree module used by DSH plugins and standalone callers.
 * @param options - Managed filesystem and journal locations.
 * @returns A lifecycle owner for worktrees recorded in the configured journal.
 */
export declare function createWorktreeManager(options: WorktreeManagerOptions): WorktreeManager;
//# sourceMappingURL=index.d.ts.map