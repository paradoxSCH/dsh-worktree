import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeManager, WorktreeView } from '../src/types.js'
import * as WorktreeTools from '../src/tools.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

function view(): WorktreeView {
  return {
    id: 'workspace-1' as WorktreeView['id'],
    state: 'ready',
    path: 'C:\\managed\\workspace-1',
    repository: 'C:\\repo',
    baseCommit: 'a'.repeat(40),
    headCommit: 'a'.repeat(40),
    branch: null,
    lifetime: 'managed',
    changes: { dirty: false, stagedFileCount: 0, unstagedFileCount: 0, untrackedFileCount: 0, newCommitCount: 0 },
    changedFromInitial: false,
    changeToken: 'token',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    activeLeases: [],
    lastValidation: undefined,
    lastDelivery: undefined,
  }
}

function managerFixture(): WorktreeManager {
  const item = view()
  return {
    create: vi.fn(async () => item),
    inspect: vi.fn(async () => item),
    acquireLease: vi.fn(),
    releaseLease: vi.fn(),
    act: vi.fn(async () => item),
    review: vi.fn(async () => ({
      worktreeId: item.id,
      changeToken: item.changeToken,
      summary: '',
      diff: '',
      untrackedPaths: [],
      truncated: false,
    })),
    validate: vi.fn(),
    conclude: vi.fn(async () => item),
    list: vi.fn(async () => [item]),
    doctor: vi.fn(async () => ({
      status: 'ok' as const,
      gitVersion: 'git version test',
      nodeVersion: process.version,
      managedRoot: 'C:\\managed',
      journalPath: 'C:\\managed\\operations.jsonl',
      recordCount: 1,
      materializedCount: 1,
      activeLeaseCount: 0,
      pending: [],
      problems: [],
    })),
    recover: vi.fn(async () => ({ recovered: [], healthy: [item.id], manual: [], orphaned: [] })),
    close: vi.fn(),
  }
}

describe('DSH worktree tools adapter', () => {
  it('publishes one high-level lifecycle surface rather than raw Git commands', async () => {
    const ctx = new Context()
    const systemPrompt = await ctx.plugin(SystemPrompt)
    cleanup.push(async () => { await systemPrompt.dispose() })
    const tools = await ctx.plugin(ToolRuntime)
    cleanup.push(async () => { await tools.dispose() })
    ctx.provide('worktrees', managerFixture())
    const plugin = await ctx.plugin(WorktreeTools, { validationCommands: [] })
    cleanup.push(async () => { await plugin.dispose() })

    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([
      'worktree_create',
      'worktree_list',
      'worktree_inspect',
      'worktree_review',
      'worktree_validate',
      'worktree_act',
      'worktree_doctor',
      'worktree_recover',
    ])
    expect(ctx.tools.schemas().some(schema => schema.name.startsWith('git_'))).toBe(false)
  })
})
