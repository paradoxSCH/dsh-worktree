import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as WorktreePlugin from '../src/index.js'
import {
  findEvent,
  repositoryFixture,
  ScriptedAdapter,
  textResponse,
  toolCallResponse,
  toolResultText,
} from './helpers/agent-harness.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

describe('dsh-worktree through the DSH agent loop', () => {
  it('isolates a foreground child edit and carries it through review and handoff', async () => {
    const fixture = await repositoryFixture()
    cleanups.push(() => rm(fixture.root, { recursive: true, force: true }))
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    const worktreeFiber = await ctx.plugin(WorktreePlugin, {
      providerName: 'worktree',
      managedRoot: fixture.managedRoot,
      journalPath: fixture.journalPath,
      sourceMode: 'head',
      lifetime: 'managed',
      pullRequestProvider: 'disabled',
    })
    cleanups.push(async () => { await worktreeFiber.dispose() })
    await ctx.plugin(ToolSubagent, {
      provider: 'worktree',
      toolName: 'subagent_worktree',
      backgroundMode: 'one-shot',
    })
    ctx.tools.register(defineTool({
      name: 'write_child_file',
      description: 'Write the integration-test artifact in the calling agent checkout.',
      parameters: {
        content: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const cwd = exec.agent?.session.header.cwd
        if (cwd === undefined) throw new Error('write_child_file requires an agent cwd')
        await writeFile(join(cwd, 'agent-result.txt'), args.content, 'utf8')
        return `wrote ${join(cwd, 'agent-result.txt')}`
      },
    }))

    const adapter = new ScriptedAdapter([
      toolCallResponse('parent-delegate', 'subagent_worktree', {
        description: 'edit isolated checkout',
        prompt: 'Create agent-result.txt containing child output.',
      }),
      toolCallResponse('child-write', 'write_child_file', { content: 'child output\n' }),
      textResponse('The isolated edit is complete.'),
      textResponse('The subagent completed in its worktree.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(
      SessionId('worktree-parent-foreground'),
      { provider: 'mock', model: 'mock' },
      { cwd: fixture.repository },
    )

    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Delegate this edit to the worktree agent.' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()

    expect(findEvent(parent, 'tool/call').data.name).toBe('subagent_worktree')
    const parentResult = findEvent(parent, 'tool/result')
    expect(parentResult.data.message.content[0].isError).toBe(false)
    expect(toolResultText(parentResult)).toContain('isolated edit is complete')
    await expect(readFile(join(fixture.repository, 'agent-result.txt'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })

    const [retained] = await ctx.worktrees.list()
    expect(retained).toMatchObject({ state: 'retained', changedFromInitial: true, activeLeases: [] })
    expect(await readFile(join(retained!.path, 'agent-result.txt'), 'utf8')).toBe('child output\n')
    const review = await ctx.worktrees.review(retained!.id)
    expect(review.untrackedPaths).toContain('agent-result.txt')

    const handedOff = await ctx.worktrees.act({
      id: retained!.id,
      action: 'handoff',
      targetPath: fixture.repository,
      changeToken: retained!.changeToken,
    })
    expect(handedOff.lastDelivery).toMatchObject({ kind: 'handoff', target: fixture.repository })
    expect(await readFile(join(fixture.repository, 'agent-result.txt'), 'utf8')).toBe('child output\n')
  }, 30_000)
})
