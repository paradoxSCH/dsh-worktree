import { open, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DirectoryMutex } from './lock.js';
export class OperationJournal {
    path;
    mutex;
    constructor(path) {
        this.path = path;
        this.mutex = new DirectoryMutex(`${path}.locks`);
    }
    async append(event) {
        await this.mutex.withLock('journal', 'journal append', async () => {
            await mkdir(dirname(this.path), { recursive: true });
            const handle = await open(this.path, 'a', 0o600);
            try {
                await handle.write(`${JSON.stringify(event)}\n`, undefined, 'utf8');
                await handle.sync();
            }
            finally {
                await handle.close();
            }
        });
    }
    async project() {
        return this.mutex.withLock('journal', 'journal projection', () => this.projectUnlocked());
    }
    async projectUnlocked() {
        let text;
        try {
            text = await readFile(this.path, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return new Map();
            throw error;
        }
        const result = new Map();
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (line === undefined || line === '')
                continue;
            let event;
            try {
                event = JSON.parse(line);
            }
            catch (error) {
                const isUnterminatedLastLine = index === lines.length - 1 && !text.endsWith('\n');
                if (isUnterminatedLastLine)
                    break;
                throw new Error(`invalid worktree journal event at line ${index + 1}`, { cause: error });
            }
            if (event.kind === 'worktree_create_planned') {
                result.set(event.record.id, {
                    record: event.record,
                    state: 'creating',
                    updatedAt: event.at,
                    pendingConclude: undefined,
                    activeLeases: new Map(),
                    pendingArchive: undefined,
                    archiveArtifact: undefined,
                    pendingRestore: undefined,
                    lastValidation: undefined,
                    pendingCommit: undefined,
                    pendingBranch: undefined,
                    lastBranch: undefined,
                    pendingHandoff: undefined,
                    handoffArtifact: undefined,
                    lastDelivery: undefined,
                    pendingMerge: undefined,
                    pendingPush: undefined,
                    pendingPullRequest: undefined,
                });
                continue;
            }
            const current = result.get(event.id);
            if (current === undefined)
                throw new Error(`worktree journal event references unknown id: ${event.id}`);
            switch (event.kind) {
                case 'worktree_snapshot_ready':
                    result.set(event.id, { ...current, updatedAt: event.at, snapshot: event.artifact });
                    break;
                case 'worktree_ready':
                    result.set(event.id, {
                        ...current,
                        state: 'ready',
                        updatedAt: event.at,
                        initialStateDigest: event.initialStateDigest,
                    });
                    break;
                case 'worktree_lease_acquired': {
                    const activeLeases = new Map(current.activeLeases);
                    activeLeases.set(event.lease.id, event.lease);
                    result.set(event.id, { ...current, updatedAt: event.at, activeLeases });
                    break;
                }
                case 'worktree_lease_released': {
                    const activeLeases = new Map(current.activeLeases);
                    activeLeases.delete(event.leaseId);
                    result.set(event.id, { ...current, updatedAt: event.at, activeLeases });
                    break;
                }
                case 'worktree_archive_planned':
                    result.set(event.id, { ...current, updatedAt: event.at, pendingArchive: event.operation });
                    break;
                case 'worktree_archive_artifact_ready':
                    result.set(event.id, { ...current, updatedAt: event.at, archiveArtifact: event.artifact });
                    break;
                case 'worktree_archived': {
                    const planned = current.pendingArchive;
                    if (planned === undefined || planned.operationId !== event.operationId) {
                        throw new Error(`archive completion has no matching plan for worktree ${event.id}`);
                    }
                    result.set(event.id, {
                        ...current,
                        state: 'archived',
                        updatedAt: event.at,
                        pendingArchive: undefined,
                        lastChanges: planned.changes,
                        lastHeadCommit: planned.headCommit,
                        lastChangedFromInitial: planned.changedFromInitial,
                        lastBranch: planned.branch,
                    });
                    break;
                }
                case 'worktree_restore_planned':
                    result.set(event.id, { ...current, updatedAt: event.at, pendingRestore: event.operationId });
                    break;
                case 'worktree_restored':
                    result.set(event.id, {
                        ...current,
                        state: 'ready',
                        updatedAt: event.at,
                        pendingRestore: undefined,
                    });
                    break;
                case 'worktree_validation_completed':
                    result.set(event.id, { ...current, updatedAt: event.at, lastValidation: event.validation });
                    break;
                case 'worktree_commit_planned':
                    result.set(event.id, { ...current, updatedAt: event.at, pendingCommit: event.operation });
                    break;
                case 'worktree_commit_completed': {
                    const planned = current.pendingCommit;
                    if (planned === undefined || planned.operationId !== event.operationId) {
                        throw new Error(`commit completion has no matching plan for worktree ${event.id}`);
                    }
                    result.set(event.id, {
                        ...current,
                        updatedAt: event.at,
                        pendingCommit: undefined,
                        lastDelivery: event.delivery,
                    });
                    break;
                }
                case 'worktree_branch_planned':
                    result.set(event.id, { ...current, updatedAt: event.at, pendingBranch: event.operation });
                    break;
                case 'worktree_branch_completed': {
                    const planned = current.pendingBranch;
                    if (planned === undefined || planned.operationId !== event.operationId || planned.name !== event.branch) {
                        throw new Error(`branch completion has no matching plan for worktree ${event.id}`);
                    }
                    result.set(event.id, {
                        ...current,
                        updatedAt: event.at,
                        pendingBranch: undefined,
                        lastBranch: event.branch,
                    });
                    break;
                }
                case 'worktree_handoff_planned':
                    result.set(event.id, { ...current, updatedAt: event.at, pendingHandoff: event.operation });
                    break;
                case 'worktree_handoff_artifact_ready':
                    result.set(event.id, { ...current, updatedAt: event.at, handoffArtifact: event.artifact });
                    break;
                case 'worktree_handoff_completed': {
                    const planned = current.pendingHandoff;
                    if (planned === undefined || planned.operationId !== event.operationId) {
                        throw new Error(`handoff completion has no matching plan for worktree ${event.id}`);
                    }
                    result.set(event.id, {
                        ...current,
                        state: 'integrated',
                        updatedAt: event.at,
                        pendingHandoff: undefined,
                        lastDelivery: event.delivery,
                    });
                    break;
                }
                case 'worktree_merge_planned':
                    result.set(event.id, { ...current, updatedAt: event.at, pendingMerge: event.operation });
                    break;
                case 'worktree_merge_completed': {
                    const planned = current.pendingMerge;
                    if (planned === undefined || planned.operationId !== event.operationId) {
                        throw new Error(`merge completion has no matching plan for worktree ${event.id}`);
                    }
                    result.set(event.id, {
                        ...current,
                        state: 'integrated',
                        updatedAt: event.at,
                        pendingMerge: undefined,
                        lastDelivery: event.delivery,
                    });
                    break;
                }
                case 'worktree_push_planned':
                    result.set(event.id, { ...current, updatedAt: event.at, pendingPush: event.operation });
                    break;
                case 'worktree_push_completed': {
                    const planned = current.pendingPush;
                    if (planned === undefined || planned.operationId !== event.operationId) {
                        throw new Error(`push completion has no matching plan for worktree ${event.id}`);
                    }
                    result.set(event.id, {
                        ...current,
                        state: 'published',
                        updatedAt: event.at,
                        pendingPush: undefined,
                        lastDelivery: event.delivery,
                    });
                    break;
                }
                case 'worktree_pull_request_planned':
                    result.set(event.id, { ...current, updatedAt: event.at, pendingPullRequest: event.operation });
                    break;
                case 'worktree_pull_request_completed': {
                    const planned = current.pendingPullRequest;
                    if (planned === undefined || planned.operationId !== event.operationId) {
                        throw new Error(`pull request completion has no matching plan for worktree ${event.id}`);
                    }
                    result.set(event.id, {
                        ...current,
                        state: 'published',
                        updatedAt: event.at,
                        pendingPullRequest: undefined,
                        lastDelivery: event.delivery,
                    });
                    break;
                }
                case 'worktree_conclude_planned':
                    result.set(event.id, {
                        ...current,
                        updatedAt: event.at,
                        pendingConclude: event.operation,
                    });
                    break;
                case 'worktree_retained':
                    result.set(event.id, {
                        ...current,
                        state: 'retained',
                        updatedAt: event.at,
                        lastChanges: event.changes,
                        lastHeadCommit: event.headCommit,
                        lastChangedFromInitial: event.changedFromInitial,
                        pendingConclude: undefined,
                    });
                    break;
                case 'worktree_removed':
                    result.set(event.id, {
                        ...current,
                        state: 'removed',
                        updatedAt: event.at,
                        lastChanges: event.changes,
                        lastHeadCommit: event.headCommit,
                        lastChangedFromInitial: event.changedFromInitial,
                        pendingConclude: undefined,
                    });
                    break;
                case 'worktree_recovery_needed':
                    result.set(event.id, { ...current, state: 'recovery-needed', updatedAt: event.at });
                    break;
            }
        }
        return result;
    }
}
//# sourceMappingURL=journal.js.map