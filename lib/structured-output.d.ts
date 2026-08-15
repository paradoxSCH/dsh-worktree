/**
 * Child-scoped structured output used by the worktree in-process runner.
 *
 * Derived from DeepSeek Harness' MIT-licensed
 * @deepseek-ai/dsh-subagent-in-process-driver implementation. It lives here
 * because rc.6 does not export the attachment interface required by a custom
 * child-session cwd adapter.
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ObjectJsonSchema } from '@deepseek-ai/dsh-tools';
export declare const STRUCTURED_OUTPUT_TOOL = "structured_output";
export declare const STRUCTURED_OUTPUT_INSTRUCTION: string;
export interface StructuredAttachment {
    captured(): {
        value: unknown;
    } | undefined;
}
export declare function attachStructuredRuntime(childCtx: Context, schema: ObjectJsonSchema): StructuredAttachment;
//# sourceMappingURL=structured-output.d.ts.map