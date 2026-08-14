import type { ResolvedSubagentStartRequest, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import { WorktreeSubagentProvider } from '../src/provider.js'
import type { WorktreeManager, WorktreeView } from '../src/types.js'

function view(overrides: Partial<WorktreeView> = {}): WorktreeView {
  return {
    id: 'worktree-1' as WorktreeView['id'],
    state: 'ready',
    path: 'C:\\managed\\worktree-1',
    repository: 'C:\\repo',
    baseCommit: 'a'.repeat(40),
    headCommit: 'a'.repeat(40),
    lifetime: 'managed',
    changes: { dirty: false, stagedFileCount: 0, unstagedFileCount: 0, untrackedFileCount: 0, newCommitCount: 0 },
    changedFromInitial: false,
    changeToken: 'token',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  }
}

function request(cwd = 'C:\\repo'): ResolvedSubagentStartRequest {
  return {
    parent: { session: { header: { cwd } } },
    signal: new AbortController().signal,
    prompt: [],
    descriptor: { label: 'test' },
  } as unknown as ResolvedSubagentStartRequest
}

function managerFixture() {
  const created = view()
  const manager = {
    create: vi.fn(async () => created),
    inspect: vi.fn(async () => created),
    conclude: vi.fn(async () => view({ state: 'removed' })),
    list: vi.fn(async () => [created]),
    recover: vi.fn(async () => ({ recovered: [], manual: [] })),
    close: vi.fn(async () => undefined),
  } satisfies WorktreeManager
  return { created, manager }
}

describe('WorktreeSubagentProvider', () => {
  it('starts the child in the managed worktree and removes an unchanged worktree after quiescence', async () => {
    const { created, manager } = managerFixture()
    const baseDispose = vi.fn(async () => undefined)
    const baseRun = { id: 'child', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: baseDispose } as unknown as SubagentRun
    const startRun = vi.fn(async () => baseRun)
    const provider = new WorktreeSubagentProvider('worktree', manager, startRun, {
      source: { kind: 'working-state', includeIgnored: 'allowlist' },
      lifetime: 'managed',
    })

    const run = await provider.start(request())
    expect(manager.create).toHaveBeenCalledWith({
      repository: 'C:\\repo',
      source: { kind: 'working-state', includeIgnored: 'allowlist' },
      lifetime: 'managed',
    })
    expect(startRun).toHaveBeenCalledWith(expect.anything(), { cwd: created.path })

    await Promise.all([run.dispose(), run.dispose()])
    expect(baseDispose).toHaveBeenCalledTimes(1)
    expect(manager.conclude).toHaveBeenCalledTimes(1)
    expect(manager.conclude).toHaveBeenCalledWith({ id: created.id, action: 'remove-clean' })
  })

  it('retains a worktree changed by the child', async () => {
    const { manager } = managerFixture()
    manager.inspect.mockResolvedValue(view({ changedFromInitial: true }))
    const baseRun = { id: 'child', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: vi.fn(async () => undefined) } as unknown as SubagentRun
    const provider = new WorktreeSubagentProvider('worktree', manager, async () => baseRun, {
      source: { kind: 'head' }, lifetime: 'ephemeral',
    })

    const run = await provider.start(request())
    await run.dispose()
    expect(manager.conclude).toHaveBeenCalledWith({ id: expect.any(String), action: 'retain' })
  })

  it('returns a durable cwd for continuable children', async () => {
    const { created, manager } = managerFixture()
    const provider = new WorktreeSubagentProvider('worktree', manager, vi.fn(), {
      source: { kind: 'head' }, lifetime: 'managed',
    })

    await expect(provider.prepareContinuable!({
      sessionId: 'child', parent: request().parent, signal: new AbortController().signal,
    } as never)).resolves.toEqual({ cwd: created.path })
    expect(manager.conclude).not.toHaveBeenCalled()
  })
})
