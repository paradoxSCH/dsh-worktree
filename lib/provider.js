import { WorktreeError } from './errors.js';
function parentRepository(request) {
    const cwd = request.parent.session.header.cwd;
    if (cwd === undefined || cwd === '') {
        throw new WorktreeError('worktree provider requires a parent session cwd', 'WORKTREE_PARENT_CWD_MISSING');
    }
    return cwd;
}
/**
 * A DSH subagent provider that publishes each child inside a durable managed
 * Git worktree. The manager owns Git state; this adapter owns the ordering
 * between child quiescence and lifecycle decisions.
 */
export class WorktreeSubagentProvider {
    name;
    manager;
    startRun;
    policy;
    capabilities = {
        outputSchema: true,
        depthLimit: true,
        toolFilter: true,
        persona: true,
    };
    inheritsParentContext = false;
    constructor(name, manager, startRun, policy) {
        this.name = name;
        this.manager = manager;
        this.startRun = startRun;
        this.policy = policy;
    }
    async start(request) {
        const { worktree, lease } = await this.createFor(parentRepository(request), {
            kind: 'subagent-run',
            id: randomUUID(),
            ...(request.label === undefined ? {} : { label: request.label }),
            parentSessionId: String(request.parent.session.id),
        });
        let base;
        try {
            base = await this.startRun(request, { cwd: worktree.path });
        }
        catch (error) {
            await this.manager.releaseLease(worktree.id, lease.id);
            await this.concludeAfterQuiescence(worktree);
            throw error;
        }
        let disposal;
        return {
            id: base.id,
            localAgent: base.localAgent,
            result: base.result,
            dispose: () => {
                disposal ??= (async () => {
                    // Never inspect or delete files until the child lifecycle owner has
                    // reached quiescence.
                    await base.dispose();
                    await this.manager.releaseLease(worktree.id, lease.id);
                    await this.concludeAfterQuiescence(worktree);
                })();
                return disposal;
            },
        };
    }
    async prepareContinuable(request) {
        if (request.signal.aborted)
            throw new WorktreeError('continuable worktree preparation was aborted', 'WORKTREE_PREPARATION_ABORTED');
        const { worktree } = await this.createFor(parentRepository(request), {
            kind: 'continuable-child',
            id: String(request.sessionId),
            parentSessionId: String(request.parent.session.id),
        });
        // DSH persists this cwd in the child's session header. The worktree remains
        // manager-owned until an explicit lifecycle action because the provider is
        // intentionally not part of later continuation teardown.
        return { cwd: worktree.path };
    }
    async createFor(repository, owner) {
        const worktree = await this.manager.create({
            repository,
            source: this.policy.source,
            lifetime: this.policy.lifetime,
        });
        try {
            const lease = await this.manager.acquireLease(worktree.id, owner);
            return { worktree, lease };
        }
        catch (error) {
            await this.concludeAfterQuiescence(worktree);
            throw error;
        }
    }
    async concludeAfterQuiescence(worktree) {
        const current = await this.manager.inspect(worktree.id);
        if (current.changedFromInitial || current.lifetime === 'permanent') {
            await this.manager.conclude({ id: current.id, action: 'retain' });
            return;
        }
        await this.manager.conclude({ id: current.id, action: 'remove-clean' });
    }
}
import { randomUUID } from 'node:crypto';
//# sourceMappingURL=provider.js.map