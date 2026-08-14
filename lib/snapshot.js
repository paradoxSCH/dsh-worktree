import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WorktreeError } from './errors.js';
function assertRelativeGitPath(path) {
    const segments = path.split('/');
    if (path === '' || isAbsolute(path) || segments.includes('..') || segments.includes('.git')) {
        throw new WorktreeError(`unsafe untracked path in working-state snapshot: ${path}`, 'WORKTREE_SNAPSHOT_PATH_UNSAFE');
    }
}
function assertDescendant(root, path) {
    const relation = relative(root, path);
    if (relation === '' || relation.startsWith('..') || isAbsolute(relation)) {
        throw new WorktreeError(`snapshot path escapes its managed root: ${path}`, 'WORKTREE_SNAPSHOT_PATH_ESCAPE');
    }
}
function hashMaterial(stagedPatch, workingPatch, files) {
    const hash = createHash('sha256');
    hash.update('dsh-worktree-snapshot-v1\0');
    hash.update(stagedPatch);
    hash.update('\0working\0');
    hash.update(workingPatch);
    for (const file of files) {
        hash.update('\0file\0');
        hash.update(file.path);
        hash.update('\0');
        hash.update(String(file.mode));
        hash.update('\0');
        hash.update(file.data);
    }
    return hash.digest('hex');
}
function decodeGitPaths(buffer) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const paths = [];
    let start = 0;
    for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] !== 0)
            continue;
        const path = decoder.decode(buffer.subarray(start, index));
        if (path !== '')
            paths.push(path);
        start = index + 1;
    }
    return paths.sort((left, right) => left.localeCompare(right));
}
export class SourceSnapshotter {
    root;
    git;
    constructor(root, git) {
        this.root = root;
        this.git = git;
    }
    async capture(repository, id, baseCommit) {
        const first = await this.captureMaterial(repository, baseCommit);
        const second = await this.captureMaterial(repository, baseCommit);
        if (first.digest !== second.digest) {
            throw new WorktreeError('parent working state changed while the snapshot was captured', 'WORKTREE_SNAPSHOT_RACED');
        }
        await mkdir(this.root, { recursive: true });
        const canonicalRoot = await realpath(this.root);
        const target = resolve(canonicalRoot, id);
        const temporary = resolve(canonicalRoot, `.${id}.${randomUUID()}.tmp`);
        assertDescendant(canonicalRoot, target);
        assertDescendant(canonicalRoot, temporary);
        await mkdir(join(temporary, 'files'), { recursive: true, mode: 0o700 });
        try {
            await writeFile(join(temporary, 'index.patch'), second.stagedPatch, { mode: 0o600 });
            await writeFile(join(temporary, 'working.patch'), second.workingPatch, { mode: 0o600 });
            for (const file of second.files) {
                const destination = resolve(temporary, 'files', ...file.path.split('/'));
                assertDescendant(temporary, destination);
                await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
                await writeFile(destination, file.data, { flag: 'wx', mode: 0o600 });
            }
            const manifest = {
                formatVersion: 1,
                worktreeId: id,
                baseCommit,
                digest: second.digest,
                files: second.files.map(file => ({ path: file.path, mode: file.mode, digest: file.digest })),
            };
            await writeFile(join(temporary, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
            await rename(temporary, target);
            return { directory: target, digest: second.digest };
        }
        catch (error) {
            await rm(temporary, { recursive: true, force: true });
            throw error;
        }
    }
    async fingerprint(repository, baseCommit) {
        const first = await this.captureMaterial(repository, baseCommit);
        const second = await this.captureMaterial(repository, baseCommit);
        if (first.digest !== second.digest) {
            throw new WorktreeError('worktree changed while its state was inspected', 'WORKTREE_INSPECTION_RACED');
        }
        return second.digest;
    }
    emptyFingerprint() {
        return hashMaterial(Buffer.alloc(0), Buffer.alloc(0), []);
    }
    async replay(artifact, id, baseCommit, worktreePath) {
        const canonicalRoot = await realpath(this.root);
        const directory = await realpath(artifact.directory);
        assertDescendant(canonicalRoot, directory);
        const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
        if (manifest.formatVersion !== 1 || manifest.worktreeId !== id || manifest.baseCommit !== baseCommit || manifest.digest !== artifact.digest) {
            throw new WorktreeError('working-state snapshot identity does not match the managed worktree', 'WORKTREE_SNAPSHOT_IDENTITY_MISMATCH');
        }
        const stagedPatch = await readFile(join(directory, 'index.patch'));
        const workingPatch = await readFile(join(directory, 'working.patch'));
        const files = [];
        for (const entry of manifest.files) {
            assertRelativeGitPath(entry.path);
            const storedPath = resolve(directory, 'files', ...entry.path.split('/'));
            assertDescendant(directory, storedPath);
            const data = await readFile(storedPath);
            const digest = createHash('sha256').update(data).digest('hex');
            if (digest !== entry.digest)
                throw new WorktreeError(`snapshot file digest mismatch: ${entry.path}`, 'WORKTREE_SNAPSHOT_DIGEST_MISMATCH');
            files.push({ path: entry.path, mode: entry.mode, digest, data });
        }
        if (hashMaterial(stagedPatch, workingPatch, files) !== artifact.digest) {
            throw new WorktreeError('working-state snapshot digest mismatch', 'WORKTREE_SNAPSHOT_DIGEST_MISMATCH');
        }
        await this.git.applyStagedPatch(worktreePath, stagedPatch);
        await this.git.applyWorkingPatch(worktreePath, workingPatch);
        for (const file of files) {
            const destination = resolve(worktreePath, ...file.path.split('/'));
            assertDescendant(worktreePath, destination);
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, file.data, { flag: 'wx', mode: file.mode });
            if (process.platform !== 'win32')
                await chmod(destination, file.mode);
        }
    }
    async remove(artifact) {
        const canonicalRoot = await realpath(this.root);
        const directory = await realpath(artifact.directory);
        assertDescendant(canonicalRoot, directory);
        const status = await lstat(directory);
        if (status.isSymbolicLink() || !status.isDirectory()) {
            throw new WorktreeError('snapshot artifact is not a real directory', 'WORKTREE_SNAPSHOT_PATH_UNSAFE');
        }
        await rm(directory, { recursive: true });
    }
    async captureMaterial(repository, baseCommit) {
        const [stagedPatch, workingPatch, untracked] = await Promise.all([
            this.git.stagedPatch(repository, baseCommit),
            this.git.workingPatch(repository),
            this.git.untrackedPaths(repository),
        ]);
        const files = [];
        for (const path of decodeGitPaths(untracked)) {
            assertRelativeGitPath(path);
            const source = resolve(repository, ...path.split('/'));
            assertDescendant(repository, source);
            const status = await lstat(source);
            if (!status.isFile() || status.isSymbolicLink()) {
                throw new WorktreeError(`working-state snapshot supports only regular untracked files: ${path}`, 'WORKTREE_SNAPSHOT_UNSUPPORTED_FILE');
            }
            const data = await readFile(source);
            files.push({
                path: path.split(sep).join('/'),
                mode: status.mode & 0o777,
                digest: createHash('sha256').update(data).digest('hex'),
                data,
            });
        }
        return { stagedPatch, workingPatch, files, digest: hashMaterial(stagedPatch, workingPatch, files) };
    }
}
//# sourceMappingURL=snapshot.js.map