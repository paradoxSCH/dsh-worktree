import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it } from 'vitest'
import * as WorktreePlugin from '../src/index.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

describe('dsh-worktree Cordis plugin', () => {
  it('publishes the shared manager and registers an HMR-scoped provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-plugin-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    const subagents = await ctx.plugin(SubagentRuntime)
    cleanup.push(async () => { await subagents.dispose() })

    const fiber = await ctx.plugin(WorktreePlugin, {
      providerName: 'isolated-worktree',
      managedRoot: join(root, 'checkouts'),
      journalPath: join(root, 'operations.jsonl'),
      sourceMode: 'working-state',
      lifetime: 'managed',
    })

    expect(ctx.worktrees).toBeDefined()
    expect(ctx.subagents.getProvider('isolated-worktree')).toBeInstanceOf(WorktreePlugin.WorktreeSubagentProvider)
    await fiber.dispose()
    expect(ctx.subagents.getProvider('isolated-worktree')).toBeUndefined()
  })
})
