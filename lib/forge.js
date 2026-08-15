import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorktreeError } from './errors.js';
const execFileAsync = promisify(execFile);
function environment() {
    const result = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'])
        delete result[name];
    return result;
}
function validate(request) {
    if (request.title.trim() === '' || request.title.length > 256 || request.body.length > 64 * 1024) {
        throw new WorktreeError('pull request title/body exceeds the supported limits', 'WORKTREE_PULL_REQUEST_INPUT_INVALID');
    }
    for (const value of [request.remote, request.headBranch, request.baseBranch ?? '', request.title, request.body]) {
        if (value.includes('\0'))
            throw new WorktreeError('pull request input contains NUL', 'WORKTREE_PULL_REQUEST_INPUT_INVALID');
    }
}
/** Idempotent GitHub adapter backed by an already-authenticated `gh` CLI. */
export class GitHubCliPullRequestPublisher {
    kind = 'github-cli';
    async ensure(request) {
        validate(request);
        const { stdout: existingOutput } = await execFileAsync('gh', [
            'pr', 'list', '--state', 'open', '--head', request.headBranch, '--json', 'url', '--limit', '10',
        ], {
            cwd: request.worktreePath,
            env: environment(),
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
        const existing = JSON.parse(existingOutput);
        const urls = existing.map(item => item.url).filter((url) => typeof url === 'string');
        if (urls.length > 1) {
            throw new WorktreeError('multiple open pull requests already use this head branch', 'WORKTREE_PULL_REQUEST_AMBIGUOUS');
        }
        if (urls[0] !== undefined)
            return { url: urls[0] };
        const args = [
            'pr', 'create', '--draft', '--head', request.headBranch,
            '--title', request.title, '--body', request.body,
            ...(request.baseBranch === undefined ? [] : ['--base', request.baseBranch]),
        ];
        const { stdout } = await execFileAsync('gh', args, {
            cwd: request.worktreePath,
            env: environment(),
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
        const url = stdout.trim().split(/\r?\n/u).find(line => /^https:\/\//u.test(line));
        if (url === undefined)
            throw new WorktreeError('GitHub CLI did not return a pull request URL', 'WORKTREE_PULL_REQUEST_URL_MISSING');
        return { url };
    }
}
//# sourceMappingURL=forge.js.map