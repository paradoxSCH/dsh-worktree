import type { ResolvedSubagentStartRequest, SubagentCapabilities, SubagentProvider, SubagentRun } from '@deepseek-ai/dsh-subagent';
import type { WorktreeInProcessRunOptions } from './in-process-runner.js';
import type { LifetimePolicy, SourcePolicy, WorktreeManager } from './types.js';
export type InProcessRunStarter = (request: ResolvedSubagentStartRequest, options: WorktreeInProcessRunOptions) => Promise<SubagentRun>;
export interface WorktreeProviderPolicy {
    readonly source: SourcePolicy;
    readonly lifetime: LifetimePolicy;
}
/**
 * A DSH subagent provider that publishes each child inside a durable managed
 * Git worktree. The manager owns Git state; this adapter owns the ordering
 * between child quiescence and lifecycle decisions.
 */
export declare class WorktreeSubagentProvider implements SubagentProvider {
    readonly name: string;
    private readonly manager;
    private readonly startRun;
    private readonly policy;
    readonly capabilities: SubagentCapabilities;
    readonly inheritsParentContext = false;
    constructor(name: string, manager: WorktreeManager, startRun: InProcessRunStarter, policy: WorktreeProviderPolicy);
    start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>;
    private createFor;
    private concludeAfterQuiescence;
}
//# sourceMappingURL=provider.d.ts.map