import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WorktreeError } from './errors.js'
import type { WorktreeId } from './types.js'
import type {} from './index.js'

const ROUTE = '/api/dsh-worktree'
const BODY_LIMIT = 1 << 20

function loopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try { hostUrl = new URL(`http://${host}`) } catch { return false }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of request) {
    const chunk = raw as Buffer
    size += chunk.length
    if (size > BODY_LIMIT) throw new WorktreeError('request body is too large', 'WORKTREE_WEB_BODY_TOO_LARGE')
    chunks.push(chunk)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be an object')
  return parsed as Record<string, unknown>
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value === '') throw new Error(`${key} must be a non-empty string`)
  return value
}

async function dispatch(ctx: Context, input: Record<string, unknown>): Promise<unknown> {
  const operation = requiredString(input, 'operation')
  if (operation === 'recover') return ctx.worktrees.recover()
  const id = requiredString(input, 'id') as WorktreeId
  if (operation === 'inspect') return ctx.worktrees.inspect(id)
  if (operation === 'review') return ctx.worktrees.review(id)
  if (operation === 'restore') return ctx.worktrees.act({ id, action: 'restore' })
  if (operation === 'retain') return ctx.worktrees.conclude({ id, action: 'retain' })
  if (operation === 'remove-clean') return ctx.worktrees.conclude({ id, action: 'remove-clean' })
  const changeToken = requiredString(input, 'changeToken')
  switch (operation) {
    case 'commit': return ctx.worktrees.act({ id, action: 'commit', message: requiredString(input, 'message'), changeToken })
    case 'create-branch': return ctx.worktrees.act({ id, action: 'create-branch', name: requiredString(input, 'name'), changeToken })
    case 'handoff': return ctx.worktrees.act({ id, action: 'handoff', targetPath: requiredString(input, 'targetPath'), changeToken })
    case 'merge': return ctx.worktrees.act({ id, action: 'merge', targetPath: requiredString(input, 'targetPath'), changeToken })
    case 'archive': return ctx.worktrees.act({ id, action: 'archive', changeToken })
    case 'push': return ctx.worktrees.act({ id, action: 'push', remote: requiredString(input, 'remote'), changeToken })
    case 'pull-request': return ctx.worktrees.act({
      id,
      action: 'pull-request',
      remote: requiredString(input, 'remote'),
      ...(typeof input.baseBranch === 'string' && input.baseBranch !== '' ? { baseBranch: input.baseBranch } : {}),
      title: requiredString(input, 'title'),
      body: typeof input.body === 'string' ? input.body : 'Created by dsh-worktree.',
      changeToken,
    })
    case 'discard': {
      if (input.confirmation !== 'discard') throw new Error('discard requires confirmation="discard"')
      return ctx.worktrees.conclude({ id, action: 'discard', changeToken, confirmation: 'discard' })
    }
    default: throw new Error(`unsupported worktree operation: ${operation}`)
  }
}

/** Register the loopback-only dashboard API while the DSH Web service exists. */
export function registerWorktreeWeb(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    async handler(request, response) {
      if (!loopback(request)) return send(response, 403, { ok: false, error: { code: 'forbidden', message: 'loopback same-origin access required' } })
      try {
        if (request.method === 'GET') {
          return send(response, 200, { ok: true, value: { worktrees: await ctx.worktrees.list(), doctor: await ctx.worktrees.doctor() } })
        }
        if (request.method !== 'POST') return send(response, 405, { ok: false, error: { code: 'method-not-allowed', message: 'GET or POST required' } })
        send(response, 200, { ok: true, value: await dispatch(ctx, await body(request)) })
      } catch (error) {
        const code = error instanceof WorktreeError ? error.code : 'bad-request'
        send(response, error instanceof WorktreeError ? 409 : 400, {
          ok: false,
          error: { code, message: error instanceof Error ? error.message : String(error) },
        })
      }
    },
  })
}
