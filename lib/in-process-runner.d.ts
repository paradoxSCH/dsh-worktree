import { type SessionEvent } from '@deepseek-ai/dsh-session';
import type { ResolvedSubagentStartRequest, SubagentRun } from '@deepseek-ai/dsh-subagent';
export interface WorktreeInProcessRunOptions {
    readonly cwd: string;
    readonly seed?: SessionEvent[];
}
export declare function startWorktreeInProcessRun(request: ResolvedSubagentStartRequest, options: WorktreeInProcessRunOptions): Promise<SubagentRun>;
//# sourceMappingURL=in-process-runner.d.ts.map