/**
 * One-shot in-process DSH child runner with an explicit child-session cwd.
 *
 * DeepSeek Harness rc.6 exposes every composition primitive needed here but
 * its shared driver can only inherit the parent cwd. This adapter keeps the
 * stock lifecycle semantics while overriding only the child metadata cwd.
 * Derived from the MIT-licensed rc.6 in-process driver.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import {
  appendDelegatedPolicyOverrides,
  applyChildComposition,
  assertSubagentMaxDepth,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  finalAssistantOutput,
  resolveChildAgentOptions,
  resolveChildDepth,
} from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentDescriptorData,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import { attachStructuredRuntime, type StructuredAttachment } from './structured-output.js'

export interface WorktreeInProcessRunOptions {
  readonly cwd: string
  readonly seed?: SessionEvent[]
}

function toStopReason(reason: TurnEndReason | undefined): SubagentStopReason {
  switch (reason?.kind) {
    case 'completed': return 'completed'
    case 'max-tokens': return 'max-tokens'
    case 'aborted': return 'aborted'
    case 'blocked': return 'refusal'
    case 'error':
    case 'interrupted':
    default: return 'error'
  }
}

function attachDescriptorAppend(childCtx: Context, descriptor: SubagentDescriptorData): void {
  let appended = false
  childCtx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (!appended && decision.kind === 'enter') {
      appended = true
      agent.session.append('subagent/descriptor', descriptor)
    }
    return decision
  })
}

export async function startWorktreeInProcessRun(
  request: ResolvedSubagentStartRequest,
  options: WorktreeInProcessRunOptions,
): Promise<SubagentRun> {
  assertSubagentMaxDepth(request.maxDepth)
  if (request.signal.aborted) throw new Error('subagent request was aborted before child publication')

  const parent = request.parent
  const childDepth = resolveChildDepth(parent, request.maxDepth)
  const childId = SessionId(randomUUID())
  const activationBoundary = options.seed?.length ?? 0
  const inherited = captureDelegatedPolicyOverrides(parent)

  let structured: StructuredAttachment | undefined
  const setup = (childCtx: Context): void => {
    appendDelegatedPolicyOverrides((childCtx.agent as Agent).session, inherited)
    applyChildComposition(childCtx, parent, {
      persona: request.persona,
      toolFilter: request.toolFilter,
    })
    if (request.outputSchema !== undefined) {
      structured = attachStructuredRuntime(childCtx, request.outputSchema)
    }
    attachDescriptorAppend(childCtx, request.descriptor)
  }

  const inheritedMeta = childSessionMeta(parent, childDepth, activationBoundary)
  const handle = await parent.ctx.agents.create({
    sessionId: childId,
    meta: { ...inheritedMeta, cwd: options.cwd },
    ...options.seed === undefined ? {} : { seed: options.seed },
    agentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),
    signal: request.signal,
    setup,
  })
  return drivePublishedRun(handle, request.signal, request.prompt, childId, activationBoundary, structured)
}

function drivePublishedRun(
  handle: AgentHandle,
  signal: AbortSignal,
  prompt: ContentBlock[],
  childId: SessionId,
  boundary: number,
  structured: StructuredAttachment | undefined,
): SubagentRun {
  const child = handle.agent
  const flags = { cancelled: false }
  const onAbort = (): void => {
    flags.cancelled = true
    child.cancel({ kind: 'parent' })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()

  const result: Promise<SubagentResult> = (async () => {
    try {
      if (!flags.cancelled) {
        child.followup(createUserMessage({ content: prompt, source: { kind: 'user' } }))
        await child.whenIdle()
      }
      return readResult(
        child,
        boundary,
        flags.cancelled,
        structured === undefined ? undefined : { captured: structured.captured() },
      )
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  })()

  return {
    id: childId,
    localAgent: child,
    result,
    async dispose(): Promise<void> {
      signal.removeEventListener('abort', onAbort)
      flags.cancelled = true
      const [disposal] = await Promise.allSettled([handle.dispose(), result])
      if (disposal.status === 'rejected') throw disposal.reason
    },
  }
}

function readResult(
  child: Agent,
  boundary: number,
  cancelled: boolean,
  structured?: { captured?: { value: unknown } | undefined },
): SubagentResult {
  const own = child.session.events.slice(boundary)
  const lastEnd = foldConsumedWork(own).end
  const output: ContentBlock[] = finalAssistantOutput(own) ?? []
  const recorded = toStopReason(lastEnd?.data.reason)
  const stopReason: SubagentStopReason = cancelled && recorded !== 'completed' ? 'aborted' : recorded
  if (structured !== undefined) {
    if (structured.captured !== undefined) {
      return { output, structured: structured.captured.value, stopReason }
    }
    if (stopReason === 'completed') return { output, stopReason: cancelled ? 'aborted' : 'error' }
  }
  return { output, stopReason }
}
