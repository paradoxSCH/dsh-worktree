import type { Context } from '@deepseek-ai/cordis';
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands';
import z from '@deepseek-ai/schemastery';
import type { LifetimePolicy, ValidationCommand } from './types.js';
export declare const name = "dsh-worktree-commands";
export declare const inject: string[];
export interface Config {
    sourceMode: 'working-state' | 'head' | 'fresh';
    lifetime: LifetimePolicy;
    validationCommands: ValidationCommand[];
}
export declare const Config: z<Config>;
export declare function executeWorktreeCommand(invocation: CommandInvocation, ctx: Context, config: Config): Promise<CommandResult>;
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=commands.d.ts.map