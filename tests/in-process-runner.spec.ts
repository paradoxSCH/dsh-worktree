import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it } from 'vitest'
import { startWorktreeInProcessRun } from '../src/in-process-runner.js'

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly response: StreamChunk[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    for (const chunk of this.response) yield chunk
  }
}

function request(parent: Agent) {
  return {
    label: 'inspect worktree',
    prompt: [{ type: 'text' as const, text: 'inspect the isolated checkout' }],
    parent,
    signal: new AbortController().signal,
    descriptor: snapshotSubagentDescriptor({
      mode: 'one-shot',
      provider: 'worktree',
      label: 'inspect worktree',
    }),
  }
}

describe('rc.6 worktree in-process runner', () => {
  it('publishes the real child with the worktree cwd without changing its parent', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(textResponse('done')))

    const parentCwd = 'C:\\repositories\\main'
    const worktreeCwd = 'C:\\managed\\worktree-42'
    const parent = ctx.agentLoop.create(
      SessionId('parent'),
      { provider: 'mock', model: 'mock' },
      { cwd: parentCwd },
    )

    const run = await startWorktreeInProcessRun(request(parent), { cwd: worktreeCwd })
    const child = ctx.agents.get(run.id)
    expect(child).toBeDefined()
    expect(child?.session.header.cwd).toBe(worktreeCwd)
    expect(parent.session.header.cwd).toBe(parentCwd)
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })

    await run.dispose()
    expect(ctx.agents.get(run.id)).toBeUndefined()
  })
})
