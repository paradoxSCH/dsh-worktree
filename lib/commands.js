import z from '@deepseek-ai/schemastery';
export const name = 'dsh-worktree-commands';
export const inject = ['commands', 'worktrees'];
export const Config = z.object({
    sourceMode: z.union(['working-state', 'head', 'fresh']).default('working-state'),
    lifetime: z.union(['ephemeral', 'managed', 'permanent']).default('managed'),
    validationCommands: z.array(z.object({
        name: z.string().required(),
        executable: z.string().required(),
        args: z.array(z.string()),
        timeoutMs: z.number(),
    })).default([]),
});
const USAGE = 'Usage: /worktree [list|create [working-state|head|fresh] [ephemeral|managed|permanent]|inspect <id>|review <id>|validate <id>|commit <id> <message>|branch <id> <name>|handoff <id>|merge <id>|push <id>|pr <id> <title>|archive <id>|restore <id>|discard <id> confirm|doctor|recover]';
function source(kind) {
    switch (kind) {
        case 'working-state': return { kind, includeIgnored: 'allowlist' };
        case 'head': return { kind };
        case 'fresh': return { kind };
    }
}
function json(value) {
    return JSON.stringify(value, null, 2);
}
function worktreeId(value) {
    if (value === undefined || value === '')
        throw new Error(USAGE);
    return value;
}
export async function executeWorktreeCommand(invocation, ctx, config) {
    const parts = invocation.rawInput.trim().split(/\s+/u).filter(Boolean);
    const command = parts[0] ?? 'list';
    try {
        switch (command) {
            case 'list': return { kind: 'success', text: json(await ctx.worktrees.list()) };
            case 'create': {
                const mode = (parts[1] ?? config.sourceMode);
                const lifetime = (parts[2] ?? config.lifetime);
                if (!['working-state', 'head', 'fresh'].includes(mode) || !['ephemeral', 'managed', 'permanent'].includes(lifetime)) {
                    return { kind: 'error', text: USAGE };
                }
                const repository = invocation.agent.session.header.cwd;
                if (repository === undefined || repository === '')
                    return { kind: 'error', text: 'The current session has no repository cwd.' };
                return { kind: 'success', text: json(await ctx.worktrees.create({ repository, source: source(mode), lifetime })) };
            }
            case 'inspect': return { kind: 'success', text: json(await ctx.worktrees.inspect(worktreeId(parts[1]))) };
            case 'review': return { kind: 'success', text: json(await ctx.worktrees.review(worktreeId(parts[1]), 256 * 1024)) };
            case 'validate': return { kind: 'success', text: json(await ctx.worktrees.validate(worktreeId(parts[1]), config.validationCommands)) };
            case 'commit': {
                const id = worktreeId(parts[1]);
                const message = parts.slice(2).join(' ').trim();
                if (message === '')
                    return { kind: 'error', text: USAGE };
                const inspected = await ctx.worktrees.inspect(id);
                return { kind: 'success', text: json(await ctx.worktrees.act({ id, action: 'commit', message, changeToken: inspected.changeToken })) };
            }
            case 'branch': {
                const id = worktreeId(parts[1]);
                const branch = parts[2];
                if (branch === undefined)
                    return { kind: 'error', text: USAGE };
                const inspected = await ctx.worktrees.inspect(id);
                return { kind: 'success', text: json(await ctx.worktrees.act({ id, action: 'create-branch', name: branch, changeToken: inspected.changeToken })) };
            }
            case 'archive': {
                const id = worktreeId(parts[1]);
                const inspected = await ctx.worktrees.inspect(id);
                return { kind: 'success', text: json(await ctx.worktrees.act({ id, action: 'archive', changeToken: inspected.changeToken })) };
            }
            case 'handoff': {
                const id = worktreeId(parts[1]);
                const targetPath = invocation.agent.session.header.cwd;
                if (targetPath === undefined || targetPath === '')
                    return { kind: 'error', text: 'The current session has no target cwd.' };
                const inspected = await ctx.worktrees.inspect(id);
                return { kind: 'success', text: json(await ctx.worktrees.act({
                        id,
                        action: 'handoff',
                        targetPath,
                        changeToken: inspected.changeToken,
                    })) };
            }
            case 'merge': {
                const id = worktreeId(parts[1]);
                const targetPath = invocation.agent.session.header.cwd;
                if (targetPath === undefined || targetPath === '')
                    return { kind: 'error', text: 'The current session has no target cwd.' };
                const inspected = await ctx.worktrees.inspect(id);
                return { kind: 'success', text: json(await ctx.worktrees.act({
                        id,
                        action: 'merge',
                        targetPath,
                        changeToken: inspected.changeToken,
                    })) };
            }
            case 'push': {
                const id = worktreeId(parts[1]);
                const inspected = await ctx.worktrees.inspect(id);
                return { kind: 'success', text: json(await ctx.worktrees.act({
                        id,
                        action: 'push',
                        remote: 'origin',
                        changeToken: inspected.changeToken,
                    })) };
            }
            case 'pr': {
                const id = worktreeId(parts[1]);
                const title = parts.slice(2).join(' ').trim();
                if (title === '')
                    return { kind: 'error', text: USAGE };
                const inspected = await ctx.worktrees.inspect(id);
                return { kind: 'success', text: json(await ctx.worktrees.act({
                        id,
                        action: 'pull-request',
                        remote: 'origin',
                        title,
                        body: 'Created by dsh-worktree.',
                        changeToken: inspected.changeToken,
                    })) };
            }
            case 'restore': return { kind: 'success', text: json(await ctx.worktrees.act({ id: worktreeId(parts[1]), action: 'restore' })) };
            case 'discard': {
                const id = worktreeId(parts[1]);
                if (parts[2] !== 'confirm')
                    return { kind: 'error', text: 'Discard requires: /worktree discard <id> confirm' };
                const inspected = await ctx.worktrees.inspect(id);
                return {
                    kind: 'success',
                    text: json(await ctx.worktrees.conclude({
                        id,
                        action: 'discard',
                        changeToken: inspected.changeToken,
                        confirmation: 'discard',
                    })),
                };
            }
            case 'recover': return { kind: 'success', text: json(await ctx.worktrees.recover()) };
            case 'doctor': return { kind: 'success', text: json(await ctx.worktrees.doctor()) };
            default: return { kind: 'error', text: USAGE };
        }
    }
    catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
    }
}
export function apply(ctx, config) {
    ctx.commands.register({
        name: 'worktree',
        description: 'create, review, validate, deliver, archive, restore, or recover managed worktrees',
        input: { hint: '[subcommand]' },
        handler: invocation => executeWorktreeCommand(invocation, ctx, config),
    });
}
//# sourceMappingURL=commands.js.map