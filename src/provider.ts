import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import type { InProcessRunOptions } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { WorktreeError } from './errors.js'
import type { LifetimePolicy, SourcePolicy, WorktreeLease, WorktreeManager, WorktreeView } from './types.js'

export type InProcessRunStarter = (
  request: ResolvedSubagentStartRequest,
  options: InProcessRunOptions,
) => Promise<SubagentRun>

export interface WorktreeProviderPolicy {
  readonly source: SourcePolicy
  readonly lifetime: LifetimePolicy
}

function parentRepository(request: { readonly parent: { readonly session: { readonly header: { readonly cwd?: string } } } }): string {
  const cwd = request.parent.session.header.cwd
  if (cwd === undefined || cwd === '') {
    throw new WorktreeError('worktree provider requires a parent session cwd', 'WORKTREE_PARENT_CWD_MISSING')
  }
  return cwd
}

/**
 * A DSH subagent provider that publishes each child inside a durable managed
 * Git worktree. The manager owns Git state; this adapter owns the ordering
 * between child quiescence and lifecycle decisions.
 */
export class WorktreeSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly manager: WorktreeManager,
    private readonly startRun: InProcessRunStarter,
    private readonly policy: WorktreeProviderPolicy,
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const { worktree, lease } = await this.createFor(parentRepository(request), {
      kind: 'subagent-run',
      id: randomUUID(),
      ...(request.label === undefined ? {} : { label: request.label }),
      parentSessionId: String(request.parent.session.id),
    })
    let base: SubagentRun
    try {
      base = await this.startRun(request, { cwd: worktree.path })
    } catch (error) {
      await this.manager.releaseLease(worktree.id, lease.id)
      await this.concludeAfterQuiescence(worktree)
      throw error
    }

    let disposal: Promise<void> | undefined
    return {
      id: base.id,
      localAgent: base.localAgent,
      result: base.result,
      dispose: () => {
        disposal ??= (async () => {
          // Never inspect or delete files until the child lifecycle owner has
          // reached quiescence.
          await base.dispose()
          await this.manager.releaseLease(worktree.id, lease.id)
          await this.concludeAfterQuiescence(worktree)
        })()
        return disposal
      },
    }
  }

  async prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    if (request.signal.aborted) throw new WorktreeError('continuable worktree preparation was aborted', 'WORKTREE_PREPARATION_ABORTED')
    const { worktree } = await this.createFor(parentRepository(request), {
      kind: 'continuable-child',
      id: String(request.sessionId),
      parentSessionId: String(request.parent.session.id),
    })
    // DSH persists this cwd in the child's session header. The worktree remains
    // manager-owned until an explicit lifecycle action because the provider is
    // intentionally not part of later continuation teardown.
    return { cwd: worktree.path }
  }

  private async createFor(
    repository: string,
    owner: Parameters<WorktreeManager['acquireLease']>[1],
  ): Promise<{ readonly worktree: WorktreeView; readonly lease: WorktreeLease }> {
    const worktree = await this.manager.create({
      repository,
      source: this.policy.source,
      lifetime: this.policy.lifetime,
    })
    try {
      const lease = await this.manager.acquireLease(worktree.id, owner)
      return { worktree, lease }
    } catch (error) {
      await this.concludeAfterQuiescence(worktree)
      throw error
    }
  }

  private async concludeAfterQuiescence(worktree: WorktreeView): Promise<void> {
    const current = await this.manager.inspect(worktree.id)
    if (current.changedFromInitial || current.lifetime === 'permanent') {
      await this.manager.conclude({ id: current.id, action: 'retain' })
      return
    }
    await this.manager.conclude({ id: current.id, action: 'remove-clean' })
  }
}
import { randomUUID } from 'node:crypto'
