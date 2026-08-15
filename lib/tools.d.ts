import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ValidationCommand } from './types.js';
export declare const name = "dsh-worktree-tools";
export declare const inject: string[];
export interface Config {
    validationCommands: ValidationCommand[];
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=tools.d.ts.map