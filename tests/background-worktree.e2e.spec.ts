import { access, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as WorktreePlugin from '../src/index.js'
import {
  findEvent,
  ParentChildAdapter,
  pollUntil,
  repositoryFixture,
  textResponse,
  toolCallResponse,
  toolResultText,
  waitForIdle,
  type RepositoryFixture,
} from './helpers/agent-harness.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function harness(fixture: RepositoryFixture, adapter: ParentChildAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const agentLoopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs)
  const worktreeFiber = await ctx.plugin(WorktreePlugin, {
    providerName: 'worktree',
    managedRoot: fixture.managedRoot,
    journalPath: fixture.journalPath,
    sourceMode: 'head',
    lifetime: 'managed',
    pullRequestProvider: 'disabled',
  })
  cleanups.push(async () => { await worktreeFiber.dispose() })
  // AgentLoop disposal cancels/drains agent-owned jobs before the worktree
  // manager is closed, which also keeps failed tests from leaking a child.
  cleanups.push(async () => { await agentLoopFiber.dispose() })
  await ctx.plugin(ToolSubagent, {
    provider: 'worktree',
    toolName: 'subagent_worktree',
    backgroundMode: 'one-shot',
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function notices(events: readonly SessionEvent[]): SessionEvent[] {
  return events.filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin')
}

describe('background dsh-worktree jobs through the DSH agent loop', () => {
  it('keeps the lease while running, then wakes the parent and collects with job_output', async () => {
    const fixture = await repositoryFixture('dsh-worktree-background-e2e-')
    cleanups.push(() => rm(fixture.root, { recursive: true, force: true }))
    const sentinel = join(fixture.root, 'release-child')
    const adapter = new ParentChildAdapter('worktree-parent-background', [
      toolCallResponse('parent-delegate-bg', 'subagent_worktree', {
        description: 'edit in background', prompt: 'Wait for release, then create the artifact.', run_in_background: true,
      }),
      textResponse('The background task was started.'),
      toolCallResponse('parent-collect', 'job_output', { job_id: 'subagent-1', wait: true }),
      textResponse('The background result was collected.'),
    ], [
      toolCallResponse('child-gated-write', 'gated_child_write', { content: 'background output\n' }),
      textResponse('The background edit is complete.'),
    ])
    const ctx = await harness(fixture, adapter)
    ctx.tools.register(defineTool({
      name: 'gated_child_write',
      description: 'Wait for the test gate, then write in the calling checkout.',
      parameters: { content: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        const cwd = exec.agent?.session.header.cwd
        if (cwd === undefined) throw new Error('gated_child_write requires an agent cwd')
        while (!exec.signal.aborted) {
          try { await access(sentinel); break } catch { await new Promise(resolve => setTimeout(resolve, 20)) }
        }
        if (exec.signal.aborted) throw new Error('gated_child_write aborted')
        await writeFile(join(cwd, 'background-result.txt'), args.content, 'utf8')
        return 'background artifact written'
      },
    }))
    const parent = ctx.agentLoop.create(
      SessionId('worktree-parent-background'),
      { provider: 'mock', model: 'mock' },
      { cwd: fixture.repository },
    )

    const firstIdle = waitForIdle(ctx, parent)
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Start the isolated edit in the background.' }],
      source: { kind: 'user' },
    }))
    await firstIdle
    expect(toolResultText(findEvent(parent, 'tool/result'))).toBe('started background subagent task subagent-1')
    await pollUntil(async () => (await ctx.worktrees.list())[0]?.activeLeases.length === 1)
    const [running] = await ctx.worktrees.list()
    expect(running?.activeLeases).toHaveLength(1)
    expect(notices(parent.session.events)).toHaveLength(0)

    await writeFile(sentinel, '', 'utf8')
    await pollUntil(() => {
      const result = parent.session.events.findLast(event => event.type === 'tool/result')
      return result !== undefined && toolResultText(result).includes('background edit is complete')
    })
    await parent.whenIdle()

    const [retained] = await ctx.worktrees.list()
    expect(retained).toMatchObject({ state: 'retained', changedFromInitial: true, activeLeases: [] })
    expect(notices(parent.session.events)).toHaveLength(1)
    expect(toolResultText(findEvent(parent, 'tool/result', 'last'))).toContain('[status: completed]')
  }, 30_000)

  it('cancels a running child with job_kill and releases its lease before job_output settles', async () => {
    const fixture = await repositoryFixture('dsh-worktree-kill-e2e-')
    cleanups.push(() => rm(fixture.root, { recursive: true, force: true }))
    const adapter = new ParentChildAdapter('worktree-parent-kill', [
      toolCallResponse('parent-delegate-kill', 'subagent_worktree', {
        description: 'long isolated task', prompt: 'Wait indefinitely.', run_in_background: true,
      }),
      textResponse('The long task was started.'),
      toolCallResponse('parent-kill', 'job_kill', { job_id: 'subagent-1', reason: 'test cancellation' }),
      toolCallResponse('parent-read-killed', 'job_output', { job_id: 'subagent-1', wait: true }),
      textResponse('The background task was cancelled cleanly.'),
    ], ['hang'])
    const ctx = await harness(fixture, adapter)
    const parent = ctx.agentLoop.create(
      SessionId('worktree-parent-kill'),
      { provider: 'mock', model: 'mock' },
      { cwd: fixture.repository },
    )

    const startedIdle = waitForIdle(ctx, parent)
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Start the long isolated task.' }],
      source: { kind: 'user' },
    }))
    await startedIdle
    await pollUntil(async () => (await ctx.worktrees.list())[0]?.activeLeases.length === 1)
    expect((await ctx.worktrees.list())[0]?.activeLeases).toHaveLength(1)

    const killedIdle = waitForIdle(ctx, parent)
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Cancel that background task and verify it stopped.' }],
      source: { kind: 'user' },
    }))
    await killedIdle

    expect(toolResultText(findEvent(parent, 'tool/result', 'last'))).toContain('[status: killed]')
    expect(await ctx.worktrees.list()).toEqual([
      expect.objectContaining({ state: 'removed', activeLeases: [] }),
    ])
  }, 30_000)
})
