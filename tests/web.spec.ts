import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerWorktreeWeb } from '../src/web.js'
import type { WorktreeManager, WorktreeView } from '../src/types.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()?.() })

function view(): WorktreeView {
  return {
    id: 'web-1' as WorktreeView['id'], state: 'ready', path: 'C:\\managed\\web-1', repository: 'C:\\repo',
    baseCommit: 'a'.repeat(40), headCommit: 'a'.repeat(40), branch: null, lifetime: 'managed',
    changes: { dirty: true, stagedFileCount: 0, unstagedFileCount: 1, untrackedFileCount: 0, newCommitCount: 0 },
    changedFromInitial: true, changeToken: 'token', createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    activeLeases: [], lastValidation: undefined, lastDelivery: undefined,
  }
}

function managerFixture(): WorktreeManager {
  const item = view()
  return {
    create: vi.fn(async () => item), inspect: vi.fn(async () => item), acquireLease: vi.fn(), releaseLease: vi.fn(), act: vi.fn(async () => item),
    review: vi.fn(async () => ({ worktreeId: item.id, changeToken: item.changeToken, summary: '1 file changed', diff: 'diff', untrackedPaths: [], truncated: false })),
    validate: vi.fn(), conclude: vi.fn(async () => item), list: vi.fn(async () => [item]),
    recover: vi.fn(async () => ({ recovered: [], healthy: [item.id], manual: [], orphaned: [] })),
    doctor: vi.fn(async () => ({ status: 'ok' as const, gitVersion: 'git version test', nodeVersion: process.version, managedRoot: 'C:\\managed', journalPath: 'C:\\state\\operations.jsonl', recordCount: 1, materializedCount: 1, activeLeaseCount: 0, pending: [], problems: [] })),
    close: vi.fn(),
  }
}

describe('worktree Web dashboard API', () => {
  it('serves the shared projection and accepts only closed high-level actions', async () => {
    const ctx = new Context()
    const manager = managerFixture()
    ctx.provide('worktrees', manager)
    const server = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    cleanup.push(async () => { await server.dispose() })
    cleanup.push(registerWorktreeWeb(ctx))
    const url = `http://127.0.0.1:${ctx.webServer.port}/api/dsh-worktree`
    const listed = await (await fetch(url)).json() as { ok: boolean; value: { worktrees: WorktreeView[] } }
    expect(listed.ok).toBe(true)
    expect(listed.value.worktrees[0]?.id).toBe('web-1')

    const committed = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'commit', id: 'web-1', message: 'web commit', changeToken: 'token' }),
    })
    expect(committed.status).toBe(200)
    expect(manager.act).toHaveBeenCalledWith({ id: 'web-1', action: 'commit', message: 'web commit', changeToken: 'token' })

    const arbitrary = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'git-command', id: 'web-1', args: ['reset', '--hard'] }),
    })
    expect(arbitrary.status).toBe(400)
  })
})
