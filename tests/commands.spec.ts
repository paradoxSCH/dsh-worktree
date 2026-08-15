import { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { describe, expect, it, vi } from 'vitest'
import { executeWorktreeCommand, type Config } from '../src/commands.js'
import type { WorktreeManager, WorktreeView } from '../src/types.js'

function view(): WorktreeView {
  return {
    id: 'workspace-1' as WorktreeView['id'], state: 'ready', path: 'C:\\managed\\workspace-1', repository: 'C:\\repo',
    baseCommit: 'a'.repeat(40), headCommit: 'a'.repeat(40), branch: null, lifetime: 'managed',
    changes: { dirty: true, stagedFileCount: 0, unstagedFileCount: 1, untrackedFileCount: 0, newCommitCount: 0 },
    changedFromInitial: true, changeToken: 'token', createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    activeLeases: [], lastValidation: undefined, lastDelivery: undefined,
  }
}

function managerFixture(): WorktreeManager {
  const item = view()
  return {
    create: vi.fn(async () => item), inspect: vi.fn(async () => item), acquireLease: vi.fn(), releaseLease: vi.fn(),
    act: vi.fn(async () => item), review: vi.fn(), validate: vi.fn(), conclude: vi.fn(async () => item), list: vi.fn(async () => [item]),
    doctor: vi.fn(async () => ({ status: 'ok' as const, gitVersion: 'git version test', nodeVersion: process.version, managedRoot: 'C:\\managed', journalPath: 'C:\\state\\operations.jsonl', recordCount: 1, materializedCount: 1, activeLeaseCount: 0, pending: [], problems: [] })),
    recover: vi.fn(async () => ({ recovered: [], healthy: [item.id], manual: [], orphaned: [] })), close: vi.fn(),
  }
}

function invocation(rawInput: string): CommandInvocation {
  return {
    commandId: 'command-1' as CommandInvocation['commandId'],
    rawInput,
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: 'C:\\repo' } } } as CommandInvocation['agent'],
  }
}

const config: Config = { sourceMode: 'working-state', lifetime: 'managed', validationCommands: [] }

describe('DSH worktree command adapter', () => {
  it('routes doctor and guarded commit through the shared manager', async () => {
    const ctx = new Context()
    const manager = managerFixture()
    ctx.provide('worktrees', manager)
    expect(await executeWorktreeCommand(invocation('doctor'), ctx, config)).toMatchObject({ kind: 'success', text: expect.stringContaining('git version test') })
    expect(await executeWorktreeCommand(invocation('commit workspace-1 product commit'), ctx, config)).toMatchObject({ kind: 'success' })
    expect(manager.act).toHaveBeenCalledWith({ id: 'workspace-1', action: 'commit', message: 'product commit', changeToken: 'token' })
  })
})
