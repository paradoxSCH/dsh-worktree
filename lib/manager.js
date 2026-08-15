import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { WorktreeChangedError, WorktreeChangedSinceInspectionError, WorktreeError, WorktreeInUseError, WorktreeNotFoundError } from './errors.js';
import { GitCli } from './git.js';
import { OperationJournal } from './journal.js';
import { SourceSnapshotter } from './snapshot.js';
import { DirectoryMutex } from './lock.js';
import { runValidationCommand } from './validation.js';
const EMPTY_CHANGES = {
    dirty: false,
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    newCommitCount: 0,
};
function now() {
    return new Date().toISOString();
}
function comparePath(path) {
    const normalized = resolve(path).replaceAll('\\', '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function assertManagedChild(root, child) {
    const relation = relative(root, child);
    if (relation === '' || relation.startsWith('..') || isAbsolute(relation)) {
        throw new WorktreeError(`managed worktree path escapes configured root: ${child}`, 'WORKTREE_PATH_ESCAPE');
    }
}
async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
function token(id, headCommit, changes, changedFromInitial, stateDigest) {
    return createHash('sha256')
        .update(JSON.stringify({ id, headCommit, changes, changedFromInitial, stateDigest }))
        .digest('hex');
}
export class LocalWorktreeManager {
    options;
    git = new GitCli();
    journal;
    snapshotter;
    repositoryMutex;
    closed = false;
    operationTails = new Map();
    barrierTail = Promise.resolve();
    constructor(options) {
        this.options = options;
        this.journal = new OperationJournal(options.journalPath);
        this.snapshotter = new SourceSnapshotter(join(dirname(options.journalPath), 'snapshots'), this.git);
        this.repositoryMutex = new DirectoryMutex(join(dirname(options.journalPath), 'locks', 'repositories'));
    }
    async serialized(key, operation) {
        if (this.closed)
            throw new WorktreeError('worktree manager is closed', 'WORKTREE_MANAGER_CLOSED');
        const barrier = this.barrierTail;
        const previous = this.operationTails.get(key) ?? Promise.resolve();
        let release;
        const tail = new Promise((resolveTail) => { release = resolveTail; });
        this.operationTails.set(key, tail);
        await Promise.all([barrier, previous]);
        try {
            return await operation();
        }
        finally {
            release?.();
            if (this.operationTails.get(key) === tail)
                this.operationTails.delete(key);
        }
    }
    async serializedBarrier(operation) {
        if (this.closed)
            throw new WorktreeError('worktree manager is closed', 'WORKTREE_MANAGER_CLOSED');
        const previousBarrier = this.barrierTail;
        const activeOperations = [...this.operationTails.values()];
        let release;
        const barrier = new Promise((resolveTail) => { release = resolveTail; });
        this.barrierTail = barrier;
        await Promise.all([previousBarrier, ...activeOperations]);
        try {
            return await operation();
        }
        finally {
            release?.();
        }
    }
    async create(request) {
        return this.serialized(`repository:${comparePath(request.repository)}`, async () => {
            const sourceIdentity = await this.git.identify(request.repository);
            return this.repositoryMutex.withLock(sourceIdentity.commonDirectory, 'worktree create', async () => {
                await mkdir(this.options.managedRoot, { recursive: true });
                const managedRoot = await realpath(this.options.managedRoot);
                if (comparePath(managedRoot) === comparePath(sourceIdentity.topLevel)) {
                    throw new WorktreeError('managed root cannot be the source checkout', 'WORKTREE_ROOT_IS_SOURCE');
                }
                const id = randomUUID();
                const path = resolve(managedRoot, id);
                assertManagedChild(managedRoot, path);
                const fresh = request.source.kind === 'fresh'
                    ? await this.git.resolveRemoteCommit(sourceIdentity.topLevel, request.source.remote ?? 'origin', request.source.ref)
                    : undefined;
                const baseCommit = fresh?.commit ?? await this.git.resolveCommit(sourceIdentity.topLevel, request.source.kind === 'head' ? request.source.ref ?? 'HEAD' : 'HEAD');
                const createdAt = now();
                const record = {
                    formatVersion: 1,
                    id,
                    operationId: randomUUID(),
                    repository: sourceIdentity.topLevel,
                    commonDirectory: sourceIdentity.commonDirectory,
                    path,
                    baseCommit,
                    lifetime: request.lifetime,
                    sourceKind: request.source.kind,
                    ignoredPatterns: request.source.kind === 'working-state' ? [...(request.source.ignoredPatterns ?? [])] : [],
                    allowSensitiveIgnored: request.source.kind === 'working-state' && request.source.allowSensitiveIgnored === true,
                    createdAt,
                };
                await this.journal.append({ kind: 'worktree_create_planned', at: createdAt, record });
                try {
                    await this.boundary('after-create-planned', id);
                    if (fresh !== undefined) {
                        await this.git.fetchRemoteCommit(sourceIdentity.topLevel, request.source.kind === 'fresh' ? request.source.remote ?? 'origin' : 'origin', fresh.ref, `refs/dsh-worktree/fetch/${id}`, baseCommit);
                    }
                    const snapshot = request.source.kind === 'working-state'
                        ? await this.snapshotter.capture(sourceIdentity.topLevel, id, baseCommit, id, {
                            ignoredPatterns: request.source.ignoredPatterns ?? [],
                            allowSensitiveIgnored: request.source.allowSensitiveIgnored === true,
                        })
                        : undefined;
                    if (snapshot !== undefined) {
                        await this.journal.append({ kind: 'worktree_snapshot_ready', at: now(), id, artifact: snapshot });
                        await this.boundary('after-snapshot-ready', id);
                    }
                    await this.git.addLocked(sourceIdentity.topLevel, path, baseCommit, `dsh:${id}`);
                    await this.boundary('after-worktree-added', id);
                    const createdIdentity = await this.git.verify(path, sourceIdentity.commonDirectory);
                    if (createdIdentity.headCommit !== baseCommit) {
                        throw new Error(`worktree HEAD mismatch: expected ${baseCommit}, observed ${createdIdentity.headCommit}`);
                    }
                    if (snapshot !== undefined) {
                        await this.snapshotter.replay(snapshot, id, baseCommit, path);
                        await this.boundary('after-snapshot-replayed', id);
                    }
                    const initialStateDigest = await this.snapshotter.fingerprint(path, baseCommit, this.snapshotOptions(record));
                    if (snapshot !== undefined && initialStateDigest !== snapshot.digest) {
                        throw new WorktreeError('replayed working state differs from its durable snapshot', 'WORKTREE_SNAPSHOT_REPLAY_MISMATCH');
                    }
                    await this.journal.append({ kind: 'worktree_ready', at: now(), id, initialStateDigest });
                    await this.boundary('after-ready', id);
                }
                catch (error) {
                    await this.journal.append({
                        kind: 'worktree_recovery_needed',
                        at: now(),
                        id,
                        reason: error instanceof Error ? error.message : String(error),
                    });
                    throw error;
                }
                return this.inspectUnserialized(id);
            });
        });
    }
    inspect(id) {
        return this.serialized(`worktree:${id}`, () => this.inspectUnserialized(id));
    }
    async inspectUnserialized(id) {
        const projection = (await this.journal.project()).get(id);
        if (projection === undefined)
            throw new WorktreeNotFoundError(id);
        if (projection.state === 'removed')
            return this.removedView(projection);
        if (projection.state === 'archived')
            return this.inactiveView(projection);
        await this.git.verify(projection.record.path, projection.record.commonDirectory);
        const observed = await this.git.changes(projection.record.path, projection.record.baseCommit);
        const branch = await this.git.currentBranch(projection.record.path);
        const currentStateDigest = await this.snapshotter.fingerprint(projection.record.path, projection.record.baseCommit, this.snapshotOptions(projection.record));
        if (projection.initialStateDigest === undefined) {
            throw new WorktreeError(`worktree ${id} has no committed initial-state digest`, 'WORKTREE_INITIAL_STATE_MISSING');
        }
        const changedFromInitial = currentStateDigest !== projection.initialStateDigest;
        return {
            id,
            state: projection.state,
            path: projection.record.path,
            repository: projection.record.repository,
            baseCommit: projection.record.baseCommit,
            headCommit: observed.headCommit,
            branch,
            lifetime: projection.record.lifetime,
            changes: observed.changes,
            changedFromInitial,
            changeToken: token(id, observed.headCommit, observed.changes, changedFromInitial, currentStateDigest),
            createdAt: projection.record.createdAt,
            updatedAt: projection.updatedAt,
            activeLeases: [...projection.activeLeases.values()],
            lastValidation: projection.lastValidation,
            lastDelivery: projection.lastDelivery,
        };
    }
    async review(id, maxBytes = 2 * 1024 * 1024) {
        return this.serialized(`worktree:${id}`, async () => {
            const before = await this.inspectUnserialized(id);
            const review = await this.git.review(before.path, before.baseCommit, maxBytes);
            const after = await this.inspectUnserialized(id);
            if (after.changeToken !== before.changeToken) {
                throw new WorktreeError('worktree changed while review was generated', 'WORKTREE_REVIEW_RACED');
            }
            return { worktreeId: id, changeToken: after.changeToken, ...review };
        });
    }
    async validate(id, commands) {
        return this.serialized(`worktree:${id}`, async () => {
            if (commands.length === 0 || commands.length > 32) {
                throw new WorktreeError('validation requires between 1 and 32 configured commands', 'WORKTREE_VALIDATION_COMMANDS_INVALID');
            }
            const before = await this.inspectUnserialized(id);
            if (before.activeLeases.length > 0)
                throw new WorktreeInUseError(id, before.activeLeases.length);
            const results = [];
            for (const command of commands)
                results.push(await runValidationCommand(before.path, command));
            const after = await this.inspectUnserialized(id);
            if (after.changeToken !== before.changeToken) {
                throw new WorktreeError('validation changed the worktree; result requires review', 'WORKTREE_VALIDATION_CHANGED_STATE');
            }
            const summary = {
                id: randomUUID(),
                passed: results.every(result => result.exitCode === 0),
                completedAt: now(),
                commands: results.map(result => ({
                    name: result.name,
                    exitCode: result.exitCode,
                    signal: result.signal,
                    durationMs: result.durationMs,
                })),
            };
            await this.journal.append({ kind: 'worktree_validation_completed', at: summary.completedAt, id, validation: summary });
            return { ...summary, results, changeToken: after.changeToken };
        });
    }
    async acquireLease(id, owner) {
        return this.serialized(`worktree:${id}`, async () => {
            const view = await this.inspectUnserialized(id);
            if (view.state === 'removed')
                throw new WorktreeError(`cannot acquire removed worktree ${id}`, 'WORKTREE_REMOVED');
            const lease = {
                id: randomUUID(),
                worktreeId: id,
                owner,
                acquiredAt: now(),
            };
            await this.journal.append({ kind: 'worktree_lease_acquired', at: lease.acquiredAt, id, lease });
            return lease;
        });
    }
    async releaseLease(id, leaseId) {
        return this.serialized(`worktree:${id}`, async () => {
            const projection = await this.projection(id);
            if (!projection.activeLeases.has(leaseId))
                return;
            await this.journal.append({ kind: 'worktree_lease_released', at: now(), id, leaseId });
        });
    }
    async act(request) {
        return this.serialized(`worktree:${request.id}`, async () => {
            const projection = await this.projection(request.id);
            if (projection.activeLeases.size > 0)
                throw new WorktreeInUseError(request.id, projection.activeLeases.size);
            if (request.action === 'commit') {
                const before = await this.inspectUnserialized(request.id);
                if (before.state === 'archived' || before.state === 'removed') {
                    throw new WorktreeError('commit requires a materialized worktree', 'WORKTREE_NOT_MATERIALIZED');
                }
                if (before.changeToken !== request.changeToken)
                    throw new WorktreeChangedSinceInspectionError(request.id);
                if (!before.changes.dirty)
                    throw new WorktreeError('commit requires staged, unstaged, or untracked changes', 'WORKTREE_COMMIT_CLEAN');
                const operationId = randomUUID();
                await this.journal.append({
                    kind: 'worktree_commit_planned',
                    at: now(),
                    id: request.id,
                    operation: {
                        operationId,
                        message: request.message,
                        changeToken: before.changeToken,
                        previousHeadCommit: before.headCommit,
                        contentDigest: await this.git.commitContentDigest(before.path),
                    },
                });
                await this.boundary('after-commit-planned', request.id);
                await this.repositoryMutex.withLock(projection.record.commonDirectory, 'worktree commit', () => this.finishCommit(request.id));
                return this.inspectUnserialized(request.id);
            }
            if (request.action === 'create-branch') {
                const before = await this.inspectUnserialized(request.id);
                if (before.state === 'archived' || before.state === 'removed') {
                    throw new WorktreeError('branch creation requires a materialized worktree', 'WORKTREE_NOT_MATERIALIZED');
                }
                if (before.changeToken !== request.changeToken)
                    throw new WorktreeChangedSinceInspectionError(request.id);
                const operationId = randomUUID();
                await this.journal.append({
                    kind: 'worktree_branch_planned',
                    at: now(),
                    id: request.id,
                    operation: {
                        operationId,
                        name: request.name,
                        changeToken: before.changeToken,
                        headCommit: before.headCommit,
                    },
                });
                await this.boundary('after-branch-planned', request.id);
                await this.repositoryMutex.withLock(projection.record.commonDirectory, 'worktree branch creation', () => this.finishBranch(request.id));
                return this.inspectUnserialized(request.id);
            }
            if (request.action === 'handoff') {
                const before = await this.inspectUnserialized(request.id);
                if (before.state === 'archived' || before.state === 'removed') {
                    throw new WorktreeError('handoff requires a materialized worktree', 'WORKTREE_NOT_MATERIALIZED');
                }
                if (before.changeToken !== request.changeToken)
                    throw new WorktreeChangedSinceInspectionError(request.id);
                const target = await this.git.identify(request.targetPath);
                if (comparePath(target.commonDirectory) !== comparePath(projection.record.commonDirectory)) {
                    throw new WorktreeError('handoff target belongs to a different repository', 'WORKTREE_HANDOFF_REPOSITORY_MISMATCH');
                }
                if (comparePath(target.topLevel) === comparePath(before.path)) {
                    throw new WorktreeError('handoff target cannot be the source worktree', 'WORKTREE_HANDOFF_TARGET_IS_SOURCE');
                }
                const targetState = await this.git.changes(target.topLevel, before.baseCommit);
                if (targetState.headCommit !== before.baseCommit || targetState.changes.dirty || targetState.changes.newCommitCount !== 0) {
                    throw new WorktreeError('handoff target must be clean and still at the source base commit', 'WORKTREE_HANDOFF_TARGET_CHANGED');
                }
                const operationId = randomUUID();
                await this.journal.append({
                    kind: 'worktree_handoff_planned',
                    at: now(),
                    id: request.id,
                    operation: {
                        operationId,
                        targetPath: target.topLevel,
                        changeToken: before.changeToken,
                        baseCommit: before.baseCommit,
                        headCommit: before.headCommit,
                    },
                });
                await this.boundary('after-handoff-planned', request.id);
                await this.repositoryMutex.withLock(projection.record.commonDirectory, 'worktree handoff', () => this.finishHandoff(request.id));
                return this.inspectUnserialized(request.id);
            }
            if (request.action === 'merge') {
                const before = await this.inspectUnserialized(request.id);
                if (before.state === 'archived' || before.state === 'removed') {
                    throw new WorktreeError('merge requires a materialized worktree', 'WORKTREE_NOT_MATERIALIZED');
                }
                if (before.changeToken !== request.changeToken)
                    throw new WorktreeChangedSinceInspectionError(request.id);
                if (before.changes.dirty) {
                    throw new WorktreeError('merge requires the source worktree to have no staged, unstaged, or untracked changes', 'WORKTREE_MERGE_SOURCE_DIRTY');
                }
                const target = await this.git.identify(request.targetPath);
                if (comparePath(target.commonDirectory) !== comparePath(projection.record.commonDirectory)) {
                    throw new WorktreeError('merge target belongs to a different repository', 'WORKTREE_MERGE_REPOSITORY_MISMATCH');
                }
                if (comparePath(target.topLevel) === comparePath(before.path)) {
                    throw new WorktreeError('merge target cannot be the source worktree', 'WORKTREE_MERGE_TARGET_IS_SOURCE');
                }
                const targetBranch = await this.git.currentBranch(target.topLevel);
                if (targetBranch === null)
                    throw new WorktreeError('merge target must have an attached branch', 'WORKTREE_MERGE_TARGET_DETACHED');
                const targetState = await this.git.changes(target.topLevel, target.headCommit);
                if (targetState.changes.dirty)
                    throw new WorktreeError('merge target must be clean', 'WORKTREE_MERGE_TARGET_CHANGED');
                const operationId = randomUUID();
                await this.journal.append({
                    kind: 'worktree_merge_planned',
                    at: now(),
                    id: request.id,
                    operation: {
                        operationId,
                        targetPath: target.topLevel,
                        targetBranch,
                        targetHeadCommit: target.headCommit,
                        sourceHeadCommit: before.headCommit,
                        changeToken: before.changeToken,
                    },
                });
                await this.boundary('after-merge-planned', request.id);
                await this.repositoryMutex.withLock(projection.record.commonDirectory, 'worktree merge', () => this.finishMerge(request.id));
                return this.inspectUnserialized(request.id);
            }
            if (request.action === 'push') {
                const before = await this.inspectUnserialized(request.id);
                if (before.state === 'archived' || before.state === 'removed') {
                    throw new WorktreeError('push requires a materialized worktree', 'WORKTREE_NOT_MATERIALIZED');
                }
                if (before.changeToken !== request.changeToken)
                    throw new WorktreeChangedSinceInspectionError(request.id);
                if (before.changes.dirty)
                    throw new WorktreeError('push requires committed source changes', 'WORKTREE_PUSH_SOURCE_DIRTY');
                if (before.branch === null)
                    throw new WorktreeError('create a branch before pushing the worktree', 'WORKTREE_PUSH_BRANCH_REQUIRED');
                const operationId = randomUUID();
                await this.journal.append({
                    kind: 'worktree_push_planned',
                    at: now(),
                    id: request.id,
                    operation: {
                        operationId,
                        remote: request.remote,
                        branch: before.branch,
                        headCommit: before.headCommit,
                        changeToken: before.changeToken,
                    },
                });
                await this.boundary('after-push-planned', request.id);
                await this.repositoryMutex.withLock(projection.record.commonDirectory, 'worktree push', () => this.finishPush(request.id));
                return this.inspectUnserialized(request.id);
            }
            if (request.action === 'pull-request') {
                const publisher = this.options.pullRequestPublisher;
                if (publisher === undefined) {
                    throw new WorktreeError('no pull request publisher is configured', 'WORKTREE_PULL_REQUEST_PUBLISHER_MISSING');
                }
                const before = await this.inspectUnserialized(request.id);
                if (before.state === 'archived' || before.state === 'removed') {
                    throw new WorktreeError('pull request creation requires a materialized worktree', 'WORKTREE_NOT_MATERIALIZED');
                }
                if (before.changeToken !== request.changeToken)
                    throw new WorktreeChangedSinceInspectionError(request.id);
                if (before.changes.dirty)
                    throw new WorktreeError('pull request creation requires committed source changes', 'WORKTREE_PUSH_SOURCE_DIRTY');
                if (before.branch === null)
                    throw new WorktreeError('create a branch before creating a pull request', 'WORKTREE_PUSH_BRANCH_REQUIRED');
                const operationId = randomUUID();
                await this.journal.append({
                    kind: 'worktree_pull_request_planned',
                    at: now(),
                    id: request.id,
                    operation: {
                        operationId,
                        remote: request.remote,
                        branch: before.branch,
                        baseBranch: request.baseBranch,
                        title: request.title,
                        body: request.body,
                        headCommit: before.headCommit,
                        changeToken: before.changeToken,
                    },
                });
                await this.boundary('after-pull-request-planned', request.id);
                await this.repositoryMutex.withLock(projection.record.commonDirectory, `worktree pull request via ${publisher.kind}`, () => this.finishPullRequest(request.id));
                return this.inspectUnserialized(request.id);
            }
            if (request.action === 'archive') {
                const before = await this.inspectUnserialized(request.id);
                if (before.state === 'archived')
                    return before;
                if (before.state === 'removed')
                    throw new WorktreeError('removed worktree cannot be archived', 'WORKTREE_REMOVED');
                if (before.changeToken !== request.changeToken)
                    throw new WorktreeChangedSinceInspectionError(request.id);
                const operationId = randomUUID();
                await this.journal.append({
                    kind: 'worktree_archive_planned',
                    at: now(),
                    id: request.id,
                    operation: {
                        operationId,
                        changeToken: before.changeToken,
                        headCommit: before.headCommit,
                        changes: before.changes,
                        changedFromInitial: before.changedFromInitial,
                        branch: before.branch,
                    },
                });
                await this.boundary('after-archive-planned', request.id);
                await this.repositoryMutex.withLock(projection.record.commonDirectory, 'worktree archive', () => this.finishArchive(request.id));
                return this.inactiveView(await this.projection(request.id));
            }
            if (projection.state !== 'archived') {
                if (projection.state === 'removed')
                    throw new WorktreeError('removed worktree cannot be restored', 'WORKTREE_REMOVED');
                return this.inspectUnserialized(request.id);
            }
            const operationId = randomUUID();
            await this.journal.append({ kind: 'worktree_restore_planned', at: now(), id: request.id, operationId });
            await this.boundary('after-restore-planned', request.id);
            await this.repositoryMutex.withLock(projection.record.commonDirectory, 'worktree restore', () => this.finishRestore(request.id));
            return this.inspectUnserialized(request.id);
        });
    }
    async conclude(request) {
        return this.serialized(`worktree:${request.id}`, async () => {
            const before = await this.inspectUnserialized(request.id);
            if (before.state === 'removed')
                return before;
            if (before.activeLeases.length > 0)
                throw new WorktreeInUseError(before.id, before.activeLeases.length);
            if (request.action === 'remove-clean' && before.changedFromInitial) {
                throw new WorktreeChangedError(before.id);
            }
            if (request.action === 'discard' && request.changeToken !== before.changeToken) {
                throw new WorktreeChangedSinceInspectionError(before.id);
            }
            const projection = await this.projection(before.id);
            const operationId = randomUUID();
            await this.journal.append({
                kind: 'worktree_conclude_planned',
                at: now(),
                id: before.id,
                operation: {
                    operationId,
                    action: request.action,
                    changeToken: before.changeToken,
                    changes: before.changes,
                    changedFromInitial: before.changedFromInitial,
                    headCommit: before.headCommit,
                },
            });
            await this.boundary('after-conclude-planned', before.id);
            return this.repositoryMutex.withLock(projection.record.commonDirectory, `worktree ${request.action}`, async () => {
                await this.finishPlannedConclude(projection.record.id);
                const completed = await this.projection(before.id);
                if (completed.state === 'removed' && completed.snapshot !== undefined) {
                    await this.snapshotter.remove(completed.snapshot);
                }
                return this.inspectUnserialized(before.id);
            });
        });
    }
    async list() {
        return this.serializedBarrier(async () => {
            const projections = [...(await this.journal.project()).values()];
            const views = [];
            for (const projection of projections) {
                if (projection.state === 'removed' || projection.state === 'archived' || projection.state === 'creating' || projection.state === 'recovery-needed') {
                    views.push(this.inactiveView(projection));
                }
                else
                    views.push(await this.inspectUnserialized(projection.record.id));
            }
            return views;
        });
    }
    recover() {
        return this.serializedBarrier(async () => {
            const recovered = [];
            const healthy = [];
            const manual = [];
            const orphaned = [];
            const projections = [...(await this.journal.project()).values()];
            for (const projection of projections) {
                if (projection.state === 'removed') {
                    if (await pathExists(projection.record.path)) {
                        manual.push({ id: projection.record.id, reason: 'removed record still has a checkout path' });
                    }
                    continue;
                }
                if (projection.state === 'archived' && projection.pendingRestore === undefined) {
                    if (await pathExists(projection.record.path)) {
                        manual.push({ id: projection.record.id, reason: 'archived record still has a checkout path' });
                    }
                    else
                        healthy.push(projection.record.id);
                    continue;
                }
                try {
                    if (projection.state === 'creating' || projection.state === 'recovery-needed'
                        || projection.pendingConclude !== undefined || projection.pendingArchive !== undefined
                        || projection.pendingRestore !== undefined || projection.pendingCommit !== undefined
                        || projection.pendingBranch !== undefined
                        || projection.pendingHandoff !== undefined
                        || projection.pendingMerge !== undefined
                        || projection.pendingPush !== undefined
                        || projection.pendingPullRequest !== undefined) {
                        await this.repositoryMutex.withLock(projection.record.commonDirectory, 'worktree recovery', () => this.recoverOne(projection));
                        recovered.push(projection.record.id);
                    }
                    else {
                        if (!await pathExists(projection.record.path)) {
                            throw new WorktreeError('durable worktree checkout is missing', 'WORKTREE_PATH_MISSING');
                        }
                        await this.git.verify(projection.record.path, projection.record.commonDirectory);
                        healthy.push(projection.record.id);
                    }
                }
                catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    await this.journal.append({ kind: 'worktree_recovery_needed', at: now(), id: projection.record.id, reason });
                    manual.push({ id: projection.record.id, reason });
                }
            }
            const byRepository = new Map();
            for (const projection of projections) {
                const group = byRepository.get(projection.record.commonDirectory) ?? [];
                group.push(projection);
                byRepository.set(projection.record.commonDirectory, group);
            }
            const managedRoot = resolve(this.options.managedRoot);
            for (const group of byRepository.values()) {
                const representative = group[0];
                if (representative === undefined || !await pathExists(representative.record.repository))
                    continue;
                const known = new Set(group.map(item => comparePath(item.record.path)));
                for (const linked of await this.git.listLinkedWorktrees(representative.record.repository)) {
                    const linkedPath = resolve(linked.path);
                    const relation = relative(managedRoot, linkedPath);
                    if (relation === '' || relation.startsWith('..') || isAbsolute(relation) || known.has(comparePath(linkedPath)))
                        continue;
                    orphaned.push({
                        repository: representative.record.repository,
                        path: linkedPath,
                        reason: linked.lockReason?.startsWith('dsh:') === true
                            ? 'DSH-labelled worktree has no durable record; manual adoption or removal is required'
                            : 'unowned worktree under the managed root was left untouched',
                    });
                }
            }
            return { recovered, healthy, manual, orphaned };
        });
    }
    doctor() {
        return this.serializedBarrier(async () => {
            const projections = [...(await this.journal.project()).values()];
            const problems = [];
            const pending = [];
            let materializedCount = 0;
            let activeLeaseCount = 0;
            for (const projection of projections) {
                activeLeaseCount += projection.activeLeases.size;
                const operations = [
                    projection.pendingConclude === undefined ? undefined : `conclude:${projection.pendingConclude.action}`,
                    projection.pendingArchive === undefined ? undefined : 'archive',
                    projection.pendingRestore === undefined ? undefined : 'restore',
                    projection.pendingCommit === undefined ? undefined : 'commit',
                    projection.pendingBranch === undefined ? undefined : 'create-branch',
                    projection.pendingHandoff === undefined ? undefined : 'handoff',
                    projection.pendingMerge === undefined ? undefined : 'merge',
                    projection.pendingPush === undefined ? undefined : 'push',
                    projection.pendingPullRequest === undefined ? undefined : 'pull-request',
                ].filter((value) => value !== undefined);
                if (operations.length > 0)
                    pending.push({ id: projection.record.id, operations });
                const exists = await pathExists(projection.record.path);
                const shouldExist = projection.state !== 'removed' && projection.state !== 'archived';
                if (shouldExist) {
                    materializedCount += 1;
                    if (!exists) {
                        problems.push({ id: projection.record.id, message: 'materialized record checkout path is missing' });
                        continue;
                    }
                    try {
                        await this.git.verify(projection.record.path, projection.record.commonDirectory);
                    }
                    catch (error) {
                        problems.push({
                            id: projection.record.id,
                            message: `checkout identity verification failed: ${error instanceof Error ? error.message : String(error)}`,
                        });
                    }
                }
                else if (exists) {
                    problems.push({ id: projection.record.id, message: `${projection.state} record unexpectedly still has a checkout path` });
                }
            }
            let gitVersion;
            try {
                const cwd = projections.find(item => item.state !== 'removed' && item.state !== 'archived')?.record.path
                    ?? projections[0]?.record.repository
                    ?? process.cwd();
                gitVersion = await this.git.version(cwd);
            }
            catch (error) {
                gitVersion = 'unavailable';
                problems.push({ message: `Git version check failed: ${error instanceof Error ? error.message : String(error)}` });
            }
            return {
                status: problems.length === 0 && pending.length === 0 ? 'ok' : 'attention',
                gitVersion,
                nodeVersion: process.version,
                managedRoot: resolve(this.options.managedRoot),
                journalPath: resolve(this.options.journalPath),
                recordCount: projections.length,
                materializedCount,
                activeLeaseCount,
                pending,
                problems,
            };
        });
    }
    async close() {
        this.closed = true;
        await Promise.all([this.barrierTail, ...this.operationTails.values()]);
    }
    async projection(id) {
        const projection = (await this.journal.project()).get(id);
        if (projection === undefined)
            throw new WorktreeNotFoundError(id);
        return projection;
    }
    snapshotOptions(record) {
        return {
            ignoredPatterns: record.ignoredPatterns ?? [],
            allowSensitiveIgnored: record.allowSensitiveIgnored ?? false,
        };
    }
    async boundary(boundary, id) {
        await this.options.onBoundary?.(boundary, id);
    }
    async recoverOne(projection) {
        if (projection.pendingPullRequest !== undefined) {
            await this.finishPullRequest(projection.record.id);
            return;
        }
        if (projection.pendingPush !== undefined) {
            await this.finishPush(projection.record.id);
            return;
        }
        if (projection.pendingMerge !== undefined) {
            await this.finishMerge(projection.record.id);
            return;
        }
        if (projection.pendingHandoff !== undefined) {
            await this.finishHandoff(projection.record.id);
            return;
        }
        if (projection.pendingCommit !== undefined) {
            await this.finishCommit(projection.record.id);
            return;
        }
        if (projection.pendingBranch !== undefined) {
            await this.finishBranch(projection.record.id);
            return;
        }
        if (projection.pendingRestore !== undefined) {
            await this.finishRestore(projection.record.id);
            return;
        }
        if (projection.pendingArchive !== undefined) {
            await this.finishArchive(projection.record.id);
            return;
        }
        if (projection.pendingConclude !== undefined) {
            await this.finishPlannedConclude(projection.record.id);
            return;
        }
        const { record } = projection;
        const hasPath = await pathExists(record.path);
        if (!hasPath) {
            if (record.sourceKind === 'working-state' && projection.snapshot === undefined) {
                throw new WorktreeError('working-state snapshot was not durably captured before interruption', 'WORKTREE_RECOVERY_SNAPSHOT_MISSING');
            }
            await this.git.addLocked(record.repository, record.path, record.baseCommit, `dsh:${record.id}`);
        }
        await this.git.verify(record.path, record.commonDirectory);
        let digest = await this.snapshotter.fingerprint(record.path, record.baseCommit, this.snapshotOptions(record));
        if (record.sourceKind === 'working-state') {
            const snapshot = projection.snapshot;
            if (snapshot === undefined) {
                throw new WorktreeError('working-state recovery has no durable snapshot', 'WORKTREE_RECOVERY_SNAPSHOT_MISSING');
            }
            if (digest === this.snapshotter.emptyFingerprint()) {
                await this.snapshotter.replay(snapshot, record.id, record.baseCommit, record.path);
                digest = await this.snapshotter.fingerprint(record.path, record.baseCommit, this.snapshotOptions(record));
            }
            if (digest !== snapshot.digest) {
                throw new WorktreeError('interrupted worktree differs from both its empty and captured states', 'WORKTREE_RECOVERY_AMBIGUOUS_STATE');
            }
        }
        else if (digest !== this.snapshotter.emptyFingerprint()) {
            throw new WorktreeError('interrupted worktree contains unplanned changes', 'WORKTREE_RECOVERY_AMBIGUOUS_STATE');
        }
        await this.journal.append({ kind: 'worktree_ready', at: now(), id: record.id, initialStateDigest: digest });
    }
    async finishBranch(id) {
        const projection = await this.projection(id);
        const operation = projection.pendingBranch;
        if (operation === undefined)
            return;
        if (!await pathExists(projection.record.path)) {
            throw new WorktreeError('worktree checkout is missing during branch creation', 'WORKTREE_PATH_MISSING');
        }
        const current = await this.inspectUnserialized(id);
        if (current.changeToken !== operation.changeToken || current.headCommit !== operation.headCommit) {
            throw new WorktreeChangedSinceInspectionError(id);
        }
        if (current.branch !== operation.name) {
            if (current.branch !== null) {
                throw new WorktreeError(`worktree is already attached to branch ${current.branch}`, 'WORKTREE_BRANCH_ALREADY_ATTACHED');
            }
            await this.git.attachBranch(projection.record.path, operation.name, operation.headCommit);
            await this.boundary('after-branch-attached', id);
        }
        await this.journal.append({
            kind: 'worktree_branch_completed',
            at: now(),
            id,
            operationId: operation.operationId,
            branch: operation.name,
        });
        await this.boundary('after-branch-completed', id);
    }
    async finishCommit(id) {
        const projection = await this.projection(id);
        const operation = projection.pendingCommit;
        if (operation === undefined)
            return;
        if (!await pathExists(projection.record.path)) {
            throw new WorktreeError('worktree checkout is missing during commit', 'WORKTREE_PATH_MISSING');
        }
        const current = await this.inspectUnserialized(id);
        let committedHead = current.headCommit;
        if (current.headCommit === operation.previousHeadCommit) {
            const observedDigest = await this.git.commitContentDigest(projection.record.path);
            if (observedDigest !== operation.contentDigest)
                throw new WorktreeChangedSinceInspectionError(id);
            await this.git.stageAll(projection.record.path);
            await this.boundary('after-commit-staged', id);
            committedHead = await this.git.commitStaged(projection.record.path, operation.message);
            await this.boundary('after-commit-created', id);
        }
        else {
            if (current.changes.dirty || !await this.git.isAncestor(projection.record.path, operation.previousHeadCommit, current.headCommit)) {
                throw new WorktreeError('worktree diverged while recovering commit', 'WORKTREE_COMMIT_RECOVERY_DIVERGED');
            }
        }
        const delivery = {
            id: operation.operationId,
            kind: 'commit',
            target: current.branch ?? '(detached HEAD)',
            completedAt: now(),
            sourceHeadCommit: committedHead,
        };
        await this.journal.append({
            kind: 'worktree_commit_completed',
            at: delivery.completedAt,
            id,
            operationId: operation.operationId,
            delivery,
        });
        await this.boundary('after-commit-completed', id);
    }
    async finishHandoff(id) {
        let projection = await this.projection(id);
        const operation = projection.pendingHandoff;
        if (operation === undefined)
            return;
        const target = await this.git.identify(operation.targetPath);
        if (comparePath(target.commonDirectory) !== comparePath(projection.record.commonDirectory)) {
            throw new WorktreeError('handoff target repository identity changed', 'WORKTREE_HANDOFF_REPOSITORY_MISMATCH');
        }
        let artifact = projection.handoffArtifact;
        const artifactKey = `handoff-${id}-${operation.operationId}`;
        if (artifact === undefined) {
            if (!await pathExists(projection.record.path)) {
                throw new WorktreeError('handoff source checkout is missing before artifact capture', 'WORKTREE_PATH_MISSING');
            }
            const current = await this.inspectUnserialized(id);
            if (current.changeToken !== operation.changeToken)
                throw new WorktreeChangedSinceInspectionError(id);
            artifact = await this.snapshotter.load(id, operation.baseCommit, artifactKey)
                ?? await this.snapshotter.capture(projection.record.path, id, operation.baseCommit, artifactKey, this.snapshotOptions(projection.record));
            await this.journal.append({
                kind: 'worktree_handoff_artifact_ready',
                at: now(),
                id,
                operationId: operation.operationId,
                artifact,
            });
            await this.boundary('after-handoff-artifact-ready', id);
            projection = await this.projection(id);
        }
        const targetState = await this.git.changes(target.topLevel, operation.baseCommit);
        const targetDigest = await this.snapshotter.fingerprint(target.topLevel, operation.baseCommit, this.snapshotOptions(projection.record));
        if (targetDigest === this.snapshotter.emptyFingerprint()) {
            if (targetState.headCommit !== operation.baseCommit) {
                throw new WorktreeError('handoff target moved away from the planned base commit', 'WORKTREE_HANDOFF_TARGET_CHANGED');
            }
            try {
                await this.snapshotter.replay(artifact, id, operation.baseCommit, target.topLevel);
            }
            catch (error) {
                await this.git.resetHard(target.topLevel, operation.baseCommit);
                await this.snapshotter.removeReplayedUntrackedFiles(artifact, id, operation.baseCommit, target.topLevel);
                throw error;
            }
            await this.boundary('after-handoff-applied', id);
        }
        else if (targetDigest !== artifact.digest) {
            throw new WorktreeError('handoff target contains changes outside the durable artifact', 'WORKTREE_HANDOFF_TARGET_CHANGED');
        }
        const verified = await this.snapshotter.fingerprint(target.topLevel, operation.baseCommit, this.snapshotOptions(projection.record));
        if (verified !== artifact.digest) {
            throw new WorktreeError('handoff target does not match the durable artifact after apply', 'WORKTREE_HANDOFF_VERIFY_FAILED');
        }
        const delivery = {
            id: operation.operationId,
            kind: 'handoff',
            target: target.topLevel,
            completedAt: now(),
            sourceHeadCommit: operation.headCommit,
        };
        await this.journal.append({
            kind: 'worktree_handoff_completed',
            at: delivery.completedAt,
            id,
            operationId: operation.operationId,
            delivery,
        });
        await this.boundary('after-handoff-completed', id);
    }
    async finishMerge(id) {
        const projection = await this.projection(id);
        const operation = projection.pendingMerge;
        if (operation === undefined)
            return;
        const source = await this.inspectUnserialized(id);
        if (source.changeToken !== operation.changeToken || source.headCommit !== operation.sourceHeadCommit || source.changes.dirty) {
            throw new WorktreeChangedSinceInspectionError(id);
        }
        const target = await this.git.identify(operation.targetPath);
        if (comparePath(target.commonDirectory) !== comparePath(projection.record.commonDirectory)) {
            throw new WorktreeError('merge target repository identity changed', 'WORKTREE_MERGE_REPOSITORY_MISMATCH');
        }
        const targetBranch = await this.git.currentBranch(target.topLevel);
        if (targetBranch !== operation.targetBranch) {
            throw new WorktreeError('merge target branch changed after planning', 'WORKTREE_MERGE_TARGET_CHANGED');
        }
        if (target.headCommit !== operation.targetHeadCommit) {
            if (!await this.git.isAncestor(target.topLevel, operation.sourceHeadCommit, target.headCommit)) {
                throw new WorktreeError('merge target HEAD changed without containing the source result', 'WORKTREE_MERGE_TARGET_CHANGED');
            }
        }
        else {
            let targetState = await this.git.changes(target.topLevel, operation.targetHeadCommit);
            if (targetState.changes.dirty) {
                await this.git.abortMerge(target.topLevel);
                targetState = await this.git.changes(target.topLevel, operation.targetHeadCommit);
            }
            if (targetState.changes.dirty || targetState.headCommit !== operation.targetHeadCommit) {
                throw new WorktreeError('merge target is not clean at the planned commit', 'WORKTREE_MERGE_TARGET_CHANGED');
            }
            try {
                await this.git.mergeNoEdit(target.topLevel, operation.sourceHeadCommit);
            }
            catch (error) {
                await this.git.abortMerge(target.topLevel);
                throw error;
            }
            await this.boundary('after-merge-committed', id);
        }
        const mergedHead = await this.git.resolveCommit(target.topLevel, 'HEAD');
        if (!await this.git.isAncestor(target.topLevel, operation.sourceHeadCommit, mergedHead)) {
            throw new WorktreeError('merge result does not contain the source commit', 'WORKTREE_MERGE_VERIFY_FAILED');
        }
        const delivery = {
            id: operation.operationId,
            kind: 'merge',
            target: target.topLevel,
            completedAt: now(),
            sourceHeadCommit: operation.sourceHeadCommit,
        };
        await this.journal.append({
            kind: 'worktree_merge_completed',
            at: delivery.completedAt,
            id,
            operationId: operation.operationId,
            delivery,
        });
        await this.boundary('after-merge-completed', id);
    }
    async finishPush(id) {
        const projection = await this.projection(id);
        const operation = projection.pendingPush;
        if (operation === undefined)
            return;
        const source = await this.inspectUnserialized(id);
        if (source.changeToken !== operation.changeToken || source.headCommit !== operation.headCommit
            || source.branch !== operation.branch || source.changes.dirty) {
            throw new WorktreeChangedSinceInspectionError(id);
        }
        const remoteBefore = await this.git.remoteBranchCommit(source.path, operation.remote, operation.branch);
        if (remoteBefore !== operation.headCommit) {
            await this.git.pushBranch(source.path, operation.remote, operation.branch);
            await this.boundary('after-push-updated-remote', id);
        }
        const remoteAfter = await this.git.remoteBranchCommit(source.path, operation.remote, operation.branch);
        if (remoteAfter !== operation.headCommit) {
            throw new WorktreeError('remote branch does not match the planned worktree HEAD after push', 'WORKTREE_PUSH_VERIFY_FAILED');
        }
        const delivery = {
            id: operation.operationId,
            kind: 'push',
            target: `${operation.remote}/${operation.branch}`,
            completedAt: now(),
            sourceHeadCommit: operation.headCommit,
        };
        await this.journal.append({
            kind: 'worktree_push_completed',
            at: delivery.completedAt,
            id,
            operationId: operation.operationId,
            delivery,
        });
        await this.boundary('after-push-completed', id);
    }
    async finishPullRequest(id) {
        const projection = await this.projection(id);
        const operation = projection.pendingPullRequest;
        if (operation === undefined)
            return;
        const publisher = this.options.pullRequestPublisher;
        if (publisher === undefined) {
            throw new WorktreeError('no pull request publisher is configured', 'WORKTREE_PULL_REQUEST_PUBLISHER_MISSING');
        }
        const source = await this.inspectUnserialized(id);
        if (source.changeToken !== operation.changeToken || source.headCommit !== operation.headCommit
            || source.branch !== operation.branch || source.changes.dirty) {
            throw new WorktreeChangedSinceInspectionError(id);
        }
        const remoteBefore = await this.git.remoteBranchCommit(source.path, operation.remote, operation.branch);
        if (remoteBefore !== operation.headCommit) {
            await this.git.pushBranch(source.path, operation.remote, operation.branch);
            await this.boundary('after-pull-request-pushed', id);
        }
        const remoteAfter = await this.git.remoteBranchCommit(source.path, operation.remote, operation.branch);
        if (remoteAfter !== operation.headCommit) {
            throw new WorktreeError('remote branch does not match worktree HEAD before pull request creation', 'WORKTREE_PUSH_VERIFY_FAILED');
        }
        const ensured = await publisher.ensure({
            worktreePath: source.path,
            remote: operation.remote,
            headBranch: operation.branch,
            ...(operation.baseBranch === undefined ? {} : { baseBranch: operation.baseBranch }),
            title: operation.title,
            body: operation.body,
        });
        await this.boundary('after-pull-request-created', id);
        const delivery = {
            id: operation.operationId,
            kind: 'pull-request',
            target: `${operation.remote}/${operation.branch}`,
            completedAt: now(),
            sourceHeadCommit: operation.headCommit,
            url: ensured.url,
        };
        await this.journal.append({
            kind: 'worktree_pull_request_completed',
            at: delivery.completedAt,
            id,
            operationId: operation.operationId,
            delivery,
        });
        await this.boundary('after-pull-request-completed', id);
    }
    async finishArchive(id) {
        let projection = await this.projection(id);
        const operation = projection.pendingArchive;
        if (operation === undefined)
            return;
        let artifact = projection.archiveArtifact;
        const artifactKey = `archive-${id}-${operation.operationId}`;
        const archiveRef = `refs/dsh-worktree/archive/${id}`;
        if (artifact === undefined) {
            if (!await pathExists(projection.record.path)) {
                throw new WorktreeError('archive checkout disappeared before its artifact was durable', 'WORKTREE_ARCHIVE_ARTIFACT_MISSING');
            }
            const current = await this.inspectUnserialized(id);
            if (current.changeToken !== operation.changeToken)
                throw new WorktreeChangedSinceInspectionError(id);
            const existing = await this.snapshotter.load(id, operation.headCommit, artifactKey);
            const snapshot = existing ?? await this.snapshotter.capture(projection.record.path, id, operation.headCommit, artifactKey, this.snapshotOptions(projection.record));
            await this.git.preserveRef(projection.record.repository, archiveRef, operation.headCommit);
            artifact = { ref: archiveRef, headCommit: operation.headCommit, snapshot };
            await this.journal.append({
                kind: 'worktree_archive_artifact_ready',
                at: now(),
                id,
                operationId: operation.operationId,
                artifact,
            });
            await this.boundary('after-archive-artifact-ready', id);
            projection = await this.projection(id);
        }
        if (await pathExists(projection.record.path)) {
            const currentDigest = await this.snapshotter.fingerprint(projection.record.path, artifact.headCommit, this.snapshotOptions(projection.record));
            if (currentDigest !== (artifact.snapshot?.digest ?? this.snapshotter.emptyFingerprint())) {
                throw new WorktreeError('worktree changed after archive artifact capture', 'WORKTREE_ARCHIVE_STATE_CHANGED');
            }
            await this.git.verify(projection.record.path, projection.record.commonDirectory);
            await this.git.unlockForRemoval(projection.record.repository, projection.record.path);
            await this.git.remove(projection.record.repository, projection.record.path, true);
            await this.boundary('after-archive-removed', id);
        }
        await this.journal.append({ kind: 'worktree_archived', at: now(), id, operationId: operation.operationId });
        await this.boundary('after-archived', id);
    }
    async finishRestore(id) {
        const projection = await this.projection(id);
        const operationId = projection.pendingRestore;
        const artifact = projection.archiveArtifact;
        if (operationId === undefined)
            return;
        if (artifact === undefined) {
            throw new WorktreeError('archived worktree has no durable artifact', 'WORKTREE_ARCHIVE_ARTIFACT_MISSING');
        }
        if (!await pathExists(projection.record.path)) {
            await this.git.addLocked(projection.record.repository, projection.record.path, artifact.headCommit, `dsh:${id}`);
            await this.boundary('after-restore-added', id);
        }
        await this.git.verify(projection.record.path, projection.record.commonDirectory);
        let digest = await this.snapshotter.fingerprint(projection.record.path, artifact.headCommit, this.snapshotOptions(projection.record));
        if (digest === this.snapshotter.emptyFingerprint() && artifact.snapshot !== undefined) {
            await this.snapshotter.replay(artifact.snapshot, id, artifact.headCommit, projection.record.path);
            digest = await this.snapshotter.fingerprint(projection.record.path, artifact.headCommit, this.snapshotOptions(projection.record));
        }
        if (artifact.snapshot !== undefined && digest !== artifact.snapshot.digest) {
            throw new WorktreeError('restored checkout differs from its archive artifact', 'WORKTREE_ARCHIVE_RESTORE_MISMATCH');
        }
        await this.journal.append({ kind: 'worktree_restored', at: now(), id, operationId });
        await this.boundary('after-restored', id);
    }
    async finishPlannedConclude(id) {
        const projection = await this.projection(id);
        const operation = projection.pendingConclude;
        if (operation === undefined)
            return;
        const exists = await pathExists(projection.record.path);
        if (operation.action === 'retain') {
            if (!exists) {
                throw new WorktreeError('cannot retain a worktree whose checkout is missing', 'WORKTREE_RETAIN_PATH_MISSING');
            }
            await this.git.verify(projection.record.path, projection.record.commonDirectory);
            await this.journal.append({
                kind: 'worktree_retained',
                at: now(),
                id,
                operationId: operation.operationId,
                changes: operation.changes,
                changedFromInitial: operation.changedFromInitial,
                headCommit: operation.headCommit,
            });
            await this.boundary('after-conclude-completed', id);
            return;
        }
        if (exists) {
            const current = await this.inspectUnserialized(id);
            if (operation.action === 'remove-clean' && current.changedFromInitial) {
                throw new WorktreeChangedError(id);
            }
            if (current.changeToken !== operation.changeToken) {
                throw new WorktreeChangedSinceInspectionError(id);
            }
            await this.git.verify(projection.record.path, projection.record.commonDirectory);
            await this.git.unlockForRemoval(projection.record.repository, projection.record.path);
            await this.boundary('after-unlock-for-removal', id);
            // Git requires --force for an unchanged inherited working-state snapshot.
            // The durable intent and exact state token above are the destructive guard.
            await this.git.remove(projection.record.repository, projection.record.path, operation.action === 'discard' || current.changes.dirty);
            await this.boundary('after-worktree-removed', id);
        }
        await this.journal.append({
            kind: 'worktree_removed',
            at: now(),
            id,
            operationId: operation.operationId,
            changes: operation.changes,
            changedFromInitial: operation.changedFromInitial,
            headCommit: operation.headCommit,
        });
        await this.boundary('after-conclude-completed', id);
    }
    removedView(projection) {
        const changes = projection.lastChanges ?? EMPTY_CHANGES;
        const changedFromInitial = projection.lastChangedFromInitial ?? false;
        const headCommit = projection.lastHeadCommit ?? projection.record.baseCommit;
        return {
            id: projection.record.id,
            state: 'removed',
            path: projection.record.path,
            repository: projection.record.repository,
            baseCommit: projection.record.baseCommit,
            headCommit,
            branch: projection.lastBranch ?? null,
            lifetime: projection.record.lifetime,
            changes,
            changedFromInitial,
            changeToken: token(projection.record.id, headCommit, changes, changedFromInitial, projection.initialStateDigest ?? ''),
            createdAt: projection.record.createdAt,
            updatedAt: projection.updatedAt,
            activeLeases: [...projection.activeLeases.values()],
            lastValidation: projection.lastValidation,
            lastDelivery: projection.lastDelivery,
        };
    }
    inactiveView(projection) {
        const changes = projection.lastChanges ?? EMPTY_CHANGES;
        const headCommit = projection.lastHeadCommit ?? projection.record.baseCommit;
        const changedFromInitial = projection.lastChangedFromInitial ?? false;
        return {
            id: projection.record.id,
            state: projection.state,
            path: projection.record.path,
            repository: projection.record.repository,
            baseCommit: projection.record.baseCommit,
            headCommit,
            branch: projection.lastBranch ?? null,
            lifetime: projection.record.lifetime,
            changes,
            changedFromInitial,
            changeToken: token(projection.record.id, headCommit, changes, changedFromInitial, projection.initialStateDigest ?? ''),
            createdAt: projection.record.createdAt,
            updatedAt: projection.updatedAt,
            activeLeases: [...projection.activeLeases.values()],
            lastValidation: projection.lastValidation,
            lastDelivery: projection.lastDelivery,
        };
    }
}
//# sourceMappingURL=manager.js.map