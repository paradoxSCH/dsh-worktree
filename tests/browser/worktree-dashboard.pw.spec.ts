import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect, test } from '@playwright/test'
import { registerWorktreeWeb } from '../../src/web.js'
import type { WorktreeActionRequest, WorktreeManager, WorktreeView } from '../../src/types.js'

const distRoot = resolve('tests/browser/dist')
const actions: WorktreeActionRequest[] = []
let row: WorktreeView
let serverFiber: Awaited<ReturnType<Context['plugin']>>
let disposeApi: (() => void) | undefined
let disposeFallback: (() => void) | undefined
let url: string

function initialRow(): WorktreeView {
  return {
    id: 'browser-1' as WorktreeView['id'], state: 'retained', path: '/managed/browser-1', repository: '/repo',
    baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), branch: null, lifetime: 'managed',
    changes: { dirty: true, stagedFileCount: 0, unstagedFileCount: 1, untrackedFileCount: 1, newCommitCount: 0 },
    changedFromInitial: true, changeToken: 'token-1', createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z', activeLeases: [], lastValidation: undefined, lastDelivery: undefined,
  }
}

function manager(): WorktreeManager {
  return {
    create: async () => row,
    inspect: async () => row,
    acquireLease: async () => { throw new Error('not used by browser test') },
    releaseLease: async () => undefined,
    async act(request) {
      actions.push(request)
      if (request.action === 'commit') row = {
        ...row, changes: { ...row.changes, dirty: false, unstagedFileCount: 0, untrackedFileCount: 0, newCommitCount: 1 },
        changeToken: 'token-2',
      }
      if (request.action === 'archive') row = { ...row, state: 'archived', changeToken: 'token-3' }
      if (request.action === 'restore') row = { ...row, state: 'retained', changeToken: 'token-4' }
      return row
    },
    review: async () => ({
      worktreeId: row.id, changeToken: row.changeToken, summary: '2 files changed',
      diff: 'diff --git a/README.md b/README.md\n+browser change', untrackedPaths: ['notes.txt'], truncated: false,
    }),
    validate: async () => { throw new Error('not used by browser test') },
    async conclude(request) {
      if (request.action === 'discard') row = { ...row, state: 'removed', changeToken: 'token-5' }
      return row
    },
    list: async () => [row],
    recover: async () => ({ recovered: [], healthy: [row.id], manual: [], orphaned: [] }),
    doctor: async () => ({
      status: 'ok', gitVersion: 'git version browser-e2e', nodeVersion: process.version,
      managedRoot: '/managed', journalPath: '/state/operations.jsonl', recordCount: 1,
      materializedCount: row.state === 'archived' || row.state === 'removed' ? 0 : 1,
      activeLeaseCount: 0, pending: [], problems: [],
    }),
    close: async () => undefined,
  }
}

test.beforeAll(async () => {
  row = initialRow()
  const ctx = new Context()
  ctx.provide('worktrees', manager())
  serverFiber = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  disposeApi = registerWorktreeWeb(ctx)
  disposeFallback = ctx.webServer.registerFallback(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
    const file = normalize(join(distRoot, relative))
    if (!file.startsWith(`${distRoot}\\`) && !file.startsWith(`${distRoot}/`) && file !== join(distRoot, 'index.html')) {
      response.writeHead(403); response.end(); return
    }
    try {
      const content = await readFile(file)
      const mime = extname(file) === '.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'
      response.writeHead(200, { 'content-type': mime }); response.end(content)
    } catch {
      response.writeHead(404); response.end()
    }
  })
  url = `http://127.0.0.1:${ctx.webServer.port}`
})

test.afterAll(async () => {
  disposeFallback?.()
  disposeApi?.()
  await serverFiber.dispose()
})

test('registers in the sidebar and drives review, commit, archive, and restore over the real API', async ({ page }) => {
  await page.goto(url)
  await expect(page.locator('body')).toHaveAttribute('data-injected-slot', 'sidebar.footer.action')
  await expect(page.getByTitle('DSH Worktrees')).toContainText('Worktrees')
  await page.getByTitle('DSH Worktrees').click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('DSH Worktrees')).toBeVisible()
  await expect(dialog.getByText('git version browser-e2e')).toBeVisible()
  await expect(dialog.getByText('0 commits · 0 staged · 1 unstaged · 1 untracked')).toBeVisible()

  await dialog.getByRole('button', { name: 'Review' }).click()
  await expect(dialog.getByText('2 files changed')).toBeVisible()
  await expect(dialog.getByText('Untracked: notes.txt')).toBeVisible()
  await expect(dialog.getByText('+browser change')).toBeVisible()

  page.once('dialog', prompt => prompt.accept('browser commit'))
  await dialog.getByRole('button', { name: 'Commit' }).click()
  await expect(dialog.getByText('1 commits · 0 staged · 0 unstaged · 0 untracked')).toBeVisible()
  expect(actions.at(-1)).toMatchObject({ action: 'commit', message: 'browser commit', changeToken: 'token-1' })

  await dialog.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(dialog.getByText('No worktrees in this view.')).toBeVisible()
  await dialog.getByRole('button', { name: 'archived' }).click()
  await expect(dialog.getByRole('main').getByText('archived')).toBeVisible()
  await dialog.getByRole('button', { name: 'Restore' }).click()
  await expect(dialog.getByText('No worktrees in this view.')).toBeVisible()
  await dialog.getByRole('button', { name: 'active' }).click()
  await expect(dialog.getByText('retained')).toBeVisible()
  expect(actions.slice(-2).map(action => action.action)).toEqual(['archive', 'restore'])
})
