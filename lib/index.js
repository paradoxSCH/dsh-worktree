import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver';
import { WorktreeError } from './errors.js';
import { LocalWorktreeManager } from './manager.js';
import { WorktreeSubagentProvider } from './provider.js';
import { GitHubCliPullRequestPublisher } from './forge.js';
import { registerWorktreeWeb } from './web.js';
export const name = 'dsh-worktree';
export const inject = ['subagents'];
function defaultDshHome() {
    const configured = process.env.DSH_HOME;
    return configured === undefined || configured === '' ? join(homedir(), '.dsh') : resolve(configured);
}
const DEFAULT_STATE_ROOT = join(defaultDshHome(), 'plugins', 'dsh-worktree');
export const Config = z.object({
    providerName: z.string().default('worktree'),
    managedRoot: z.string().default(join(DEFAULT_STATE_ROOT, 'checkouts')),
    journalPath: z.string().default(join(DEFAULT_STATE_ROOT, 'operations.jsonl')),
    sourceMode: z.union(['head', 'working-state', 'fresh']).default('working-state'),
    sourceRemote: z.string(),
    sourceRef: z.string(),
    lifetime: z.union(['ephemeral', 'managed', 'permanent']).default('managed'),
    pullRequestProvider: z.union(['github-cli', 'disabled']).default('github-cli'),
});
function absoluteConfigPath(label, value) {
    if (value === '')
        throw new WorktreeError(`${label} must not be empty`, 'WORKTREE_CONFIG_PATH_EMPTY');
    return isAbsolute(value) ? resolve(value) : resolve(value);
}
function sourcePolicy(config) {
    switch (config.sourceMode) {
        case 'working-state':
            return { kind: 'working-state', includeIgnored: 'allowlist' };
        case 'head':
            return config.sourceRef === undefined ? { kind: 'head' } : { kind: 'head', ref: config.sourceRef };
        case 'fresh':
            return {
                kind: 'fresh',
                ...config.sourceRemote === undefined ? {} : { remote: config.sourceRemote },
                ...config.sourceRef === undefined ? {} : { ref: config.sourceRef },
            };
    }
}
/** Register the shared manager and DSH subagent provider. */
export async function apply(ctx, config) {
    const options = {
        managedRoot: absoluteConfigPath('managedRoot', config.managedRoot),
        journalPath: absoluteConfigPath('journalPath', config.journalPath),
        ...(config.pullRequestProvider === 'github-cli'
            ? { pullRequestPublisher: new GitHubCliPullRequestPublisher() }
            : {}),
    };
    const manager = new LocalWorktreeManager(options);
    const recovery = await manager.recover();
    for (const item of recovery.manual) {
        ctx.logger.warn(`dsh-worktree: manual recovery required for ${item.id}: ${item.reason}`);
    }
    ctx.provide('worktrees', manager);
    ctx.inject(['webServer'], webCtx => webCtx.effect(() => registerWorktreeWeb(webCtx), 'dsh-worktree.web'));
    ctx.effect(() => async () => manager.close(), 'dsh-worktree.close');
    ctx.subagents.registerProvider(new WorktreeSubagentProvider(config.providerName, manager, startInProcessRun, { source: sourcePolicy(config), lifetime: config.lifetime }));
}
export { WorktreeChangedError, WorktreeChangedSinceInspectionError, WorktreeError, WorktreeInUseError, WorktreeNotFoundError, } from './errors.js';
export { LocalWorktreeManager } from './manager.js';
export { WorktreeSubagentProvider } from './provider.js';
export { GitHubCliPullRequestPublisher } from './forge.js';
/**
 * Create the durable local worktree module used by DSH plugins and standalone callers.
 * @param options - Managed filesystem and journal locations.
 * @returns A lifecycle owner for worktrees recorded in the configured journal.
 */
export function createWorktreeManager(options) {
    return new LocalWorktreeManager(options);
}
//# sourceMappingURL=index.js.map