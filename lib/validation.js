import { execFile } from 'node:child_process';
import { WorktreeError } from './errors.js';
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 30 * 60_000;
const REDIRECTING_GIT_ENV = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
];
function environment() {
    const result = { ...process.env };
    for (const name of REDIRECTING_GIT_ENV)
        delete result[name];
    result.GIT_TERMINAL_PROMPT = '0';
    return result;
}
function validateCommand(command) {
    if (command.name.trim() === '' || command.executable.trim() === '' || command.executable.includes('\0')) {
        throw new WorktreeError('validation command name and executable are required', 'WORKTREE_VALIDATION_COMMAND_INVALID');
    }
    if (command.args?.some(argument => argument.includes('\0')) === true) {
        throw new WorktreeError('validation command arguments cannot contain NUL', 'WORKTREE_VALIDATION_COMMAND_INVALID');
    }
    const timeout = command.timeoutMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
        throw new WorktreeError('validation timeout is outside the supported range', 'WORKTREE_VALIDATION_TIMEOUT_INVALID');
    }
}
export async function runValidationCommand(cwd, command) {
    validateCommand(command);
    const started = Date.now();
    return new Promise(resolveRun => {
        execFile(command.executable, [...(command.args ?? [])], {
            cwd,
            env: environment(),
            encoding: 'utf8',
            maxBuffer: MAX_OUTPUT_BYTES,
            timeout: command.timeoutMs ?? 10 * 60_000,
            windowsHide: true,
        }, (error, stdout, stderr) => {
            const processError = error;
            const numericCode = typeof processError?.code === 'number' ? processError.code : error === null ? 0 : null;
            resolveRun({
                name: command.name,
                exitCode: numericCode,
                signal: processError?.signal ?? null,
                durationMs: Date.now() - started,
                stdout: String(stdout ?? ''),
                stderr: String(stderr ?? ''),
                truncated: processError?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            });
        });
    });
}
//# sourceMappingURL=validation.js.map