import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
export const name = 'dsh-worktree-tools';
export const inject = ['tools', 'worktrees'];
export const Config = z.object({
    validationCommands: z.array(z.object({
        name: z.string().required(),
        executable: z.string().required(),
        args: z.array(z.string()),
        timeoutMs: z.number(),
    })).default([]),
});
function text(value) {
    return JSON.stringify(value, null, 2);
}
function id(value) {
    return value;
}
function stringOutput() {
    return {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
    };
}
export function apply(ctx, config) {
    ctx.tools.register(defineTool({
        name: 'worktree_create',
        description: 'Create a managed worktree for the current DSH session repository without accepting arbitrary filesystem paths or Git flags.',
        parameters: {
            source: { type: 'string', enum: ['working-state', 'head', 'fresh'], description: 'Defaults to working-state.' },
            lifetime: { type: 'string', enum: ['ephemeral', 'managed', 'permanent'], description: 'Defaults to managed.' },
        },
        output: stringOutput(),
        async execute(args, exec) {
            const repository = exec.agent?.session.header.cwd;
            if (repository === undefined || repository === '')
                throw new Error('worktree_create requires an agent session cwd');
            const source = args.source ?? 'working-state';
            return text(await ctx.worktrees.create({
                repository,
                source: source === 'working-state'
                    ? { kind: 'working-state', includeIgnored: 'allowlist' }
                    : source === 'fresh' ? { kind: 'fresh' } : { kind: 'head' },
                lifetime: args.lifetime ?? 'managed',
            }));
        },
    }));
    ctx.tools.register(defineTool({
        name: 'worktree_list',
        description: 'List DSH-managed worktrees, owners, changes, archive state, and validation status.',
        parameters: {},
        output: stringOutput(),
        async execute() {
            return text(await ctx.worktrees.list());
        },
    }));
    ctx.tools.register(defineTool({
        name: 'worktree_inspect',
        description: 'Inspect one managed worktree and obtain the fresh change token required by lifecycle actions.',
        parameters: {
            id: { type: 'string', required: true, description: 'Opaque worktree id returned by worktree_list.' },
        },
        output: stringOutput(),
        async execute(args) {
            return text(await ctx.worktrees.inspect(id(args.id)));
        },
    }));
    ctx.tools.register(defineTool({
        name: 'worktree_review',
        description: 'Return a race-checked diff, summary, and untracked-file list for a managed worktree.',
        parameters: {
            id: { type: 'string', required: true, description: 'Opaque worktree id.' },
        },
        output: stringOutput(),
        async execute(args) {
            return text(await ctx.worktrees.review(id(args.id)));
        },
    }));
    ctx.tools.register(defineTool({
        name: 'worktree_validate',
        description: 'Run the administrator-configured validation suite in a quiescent managed worktree.',
        parameters: {
            id: { type: 'string', required: true, description: 'Opaque worktree id.' },
        },
        output: stringOutput(),
        async execute(args) {
            return text(await ctx.worktrees.validate(id(args.id), config.validationCommands));
        },
    }));
    ctx.tools.register(defineTool({
        name: 'worktree_act',
        description: 'Apply one guarded lifecycle action. Inspect first and pass its current changeToken for state-changing actions.',
        parameters: {
            id: { type: 'string', required: true, description: 'Opaque worktree id.' },
            action: {
                type: 'string',
                required: true,
                enum: ['retain', 'remove-clean', 'discard', 'archive', 'restore', 'commit', 'create-branch', 'handoff-current', 'merge-current', 'push-origin', 'pull-request-origin'],
            },
            changeToken: { type: 'string', description: 'Fresh token from worktree_inspect.' },
            branch: { type: 'string', description: 'Branch name for create-branch.' },
            message: { type: 'string', description: 'Commit message for commit.' },
            confirmation: { type: 'string', description: 'Must equal discard for destructive discard.' },
            title: { type: 'string', description: 'Pull request title.' },
            body: { type: 'string', description: 'Pull request body.' },
            baseBranch: { type: 'string', description: 'Optional pull request base branch.' },
        },
        output: stringOutput(),
        async execute(args, exec) {
            const worktreeId = id(args.id);
            switch (args.action) {
                case 'retain': return text(await ctx.worktrees.conclude({ id: worktreeId, action: 'retain' }));
                case 'remove-clean': return text(await ctx.worktrees.conclude({ id: worktreeId, action: 'remove-clean' }));
                case 'discard': {
                    if (args.changeToken === undefined || args.confirmation !== 'discard') {
                        throw new Error('discard requires a fresh changeToken and confirmation="discard"');
                    }
                    return text(await ctx.worktrees.conclude({
                        id: worktreeId,
                        action: 'discard',
                        changeToken: args.changeToken,
                        confirmation: 'discard',
                    }));
                }
                case 'archive': {
                    if (args.changeToken === undefined)
                        throw new Error('archive requires a fresh changeToken');
                    return text(await ctx.worktrees.act({ id: worktreeId, action: 'archive', changeToken: args.changeToken }));
                }
                case 'restore': return text(await ctx.worktrees.act({ id: worktreeId, action: 'restore' }));
                case 'commit': {
                    if (args.changeToken === undefined || args.message === undefined) {
                        throw new Error('commit requires message and a fresh changeToken');
                    }
                    return text(await ctx.worktrees.act({
                        id: worktreeId,
                        action: 'commit',
                        message: args.message,
                        changeToken: args.changeToken,
                    }));
                }
                case 'create-branch': {
                    if (args.changeToken === undefined || args.branch === undefined) {
                        throw new Error('create-branch requires branch and a fresh changeToken');
                    }
                    return text(await ctx.worktrees.act({
                        id: worktreeId,
                        action: 'create-branch',
                        name: args.branch,
                        changeToken: args.changeToken,
                    }));
                }
                case 'handoff-current': {
                    if (args.changeToken === undefined)
                        throw new Error('handoff-current requires a fresh changeToken');
                    const targetPath = exec.agent?.session.header.cwd;
                    if (targetPath === undefined || targetPath === '')
                        throw new Error('handoff-current requires an agent session cwd');
                    return text(await ctx.worktrees.act({
                        id: worktreeId,
                        action: 'handoff',
                        targetPath,
                        changeToken: args.changeToken,
                    }));
                }
                case 'merge-current': {
                    if (args.changeToken === undefined)
                        throw new Error('merge-current requires a fresh changeToken');
                    const targetPath = exec.agent?.session.header.cwd;
                    if (targetPath === undefined || targetPath === '')
                        throw new Error('merge-current requires an agent session cwd');
                    return text(await ctx.worktrees.act({
                        id: worktreeId,
                        action: 'merge',
                        targetPath,
                        changeToken: args.changeToken,
                    }));
                }
                case 'push-origin': {
                    if (args.changeToken === undefined)
                        throw new Error('push-origin requires a fresh changeToken');
                    return text(await ctx.worktrees.act({
                        id: worktreeId,
                        action: 'push',
                        remote: 'origin',
                        changeToken: args.changeToken,
                    }));
                }
                case 'pull-request-origin': {
                    if (args.changeToken === undefined || args.title === undefined) {
                        throw new Error('pull-request-origin requires title and a fresh changeToken');
                    }
                    return text(await ctx.worktrees.act({
                        id: worktreeId,
                        action: 'pull-request',
                        remote: 'origin',
                        ...(args.baseBranch === undefined ? {} : { baseBranch: args.baseBranch }),
                        title: args.title,
                        body: args.body ?? 'Created by dsh-worktree.',
                        changeToken: args.changeToken,
                    }));
                }
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'worktree_doctor',
        description: 'Check Git, durable records, checkout identity, active owners, and unfinished operations without changing worktree state.',
        parameters: {},
        output: stringOutput(),
        async execute() {
            return text(await ctx.worktrees.doctor());
        },
    }));
    ctx.tools.register(defineTool({
        name: 'worktree_recover',
        description: 'Reconcile durable worktree records with Git and report recovered, healthy, and manual cases.',
        parameters: {},
        output: stringOutput(),
        async execute() {
            return text(await ctx.worktrees.recover());
        },
    }));
    ctx.on('tools/pre-execute', async (exec, next) => {
        if (exec.name !== 'worktree_act')
            return next();
        const args = exec.arguments;
        if (args.action === 'discard') {
            return { kind: 'ask', reason: 'Discard permanently removes the selected worktree and its unintegrated changes.' };
        }
        if (args.action === 'commit' || args.action === 'handoff-current' || args.action === 'merge-current'
            || args.action === 'push-origin' || args.action === 'pull-request-origin') {
            return { kind: 'ask', reason: `${String(args.action)} changes checkout, remote branch, or forge state.` };
        }
        return next();
    });
}
//# sourceMappingURL=tools.js.map