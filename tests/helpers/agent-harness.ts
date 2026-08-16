import { execFile } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const execFileAsync = promisify(execFile)

export interface RepositoryFixture {
  readonly root: string
  readonly repository: string
  readonly managedRoot: string
  readonly journalPath: string
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return stdout.trim()
}

export async function repositoryFixture(prefix = 'dsh-worktree-agent-e2e-'): Promise<RepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const requestedRepository = join(root, 'repository')
  await execFileAsync('git', ['init', requestedRepository])
  const repository = await realpath(requestedRepository)
  await git(repository, 'config', 'core.autocrlf', 'false')
  await git(repository, 'config', 'user.name', 'dsh-worktree e2e')
  await git(repository, 'config', 'user.email', 'dsh-worktree@example.invalid')
  await writeFile(join(repository, 'README.md'), 'parent checkout\n', 'utf8')
  await git(repository, 'add', 'README.md')
  await git(repository, 'commit', '-m', 'base')
  return {
    root,
    repository,
    managedRoot: join(root, 'managed'),
    journalPath: join(root, 'state', 'operations.jsonl'),
  }
}

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
  const id = CallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

export type AdapterStep = StreamChunk[] | ((options: GenerateOptions) => StreamChunk[]) | 'hang'

export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: AdapterStep[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = this.script.shift()
    if (step === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (step === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => reject(new Error('aborted'))
        if (options.signal?.aborted === true) abort()
        else options.signal?.addEventListener('abort', abort, { once: true })
      })
      return
    }
    for (const chunk of typeof step === 'function' ? step(options) : step) yield chunk
  }
}

/** Route parent and dynamically-named child sessions independently. */
export class ParentChildAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly parentSessionId: string,
    private readonly parentScript: AdapterStep[],
    private readonly childScript: AdapterStep[],
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const script = String(options.sessionId) === this.parentSessionId ? this.parentScript : this.childScript
    const step = script.shift()
    if (step === undefined) throw new Error(`ParentChildAdapter: script exhausted for session ${String(options.sessionId)}`)
    if (step === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => reject(new Error('aborted'))
        if (options.signal?.aborted === true) abort()
        else options.signal?.addEventListener('abort', abort, { once: true })
      })
      return
    }
    for (const chunk of typeof step === 'function' ? step(options) : step) yield chunk
  }
}

export function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

export function findEvent<T extends SessionEvent['type']>(
  agent: Agent,
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? agent.session.events.find(event => event.type === type)
    : agent.session.events.findLast(event => event.type === type)
  if (found === undefined) throw new Error(`no ${type} event in session ${agent.id}`)
  return found as Extract<SessionEvent, { type: T }>
}

export function toolResultText(event: SessionEvent): string {
  if (event.type !== 'tool/result') return ''
  return event.data.message.content[0].content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

export async function pollUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}
