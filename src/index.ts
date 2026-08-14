import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { WorktreeError } from './errors.js'
import { LocalWorktreeManager } from './manager.js'
import { WorktreeSubagentProvider } from './provider.js'
import type { LifetimePolicy, SourcePolicy, WorktreeManager, WorktreeManagerOptions } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable Git worktree lifecycle shared by providers, tools, and UI adapters. */
    worktrees: WorktreeManager
  }
}

export const name = 'dsh-worktree'
export const inject = ['subagents']

export interface Config {
  providerName: string
  managedRoot: string
  journalPath: string
  sourceMode: 'head' | 'working-state' | 'fresh'
  sourceRemote?: string
  sourceRef?: string
  lifetime: LifetimePolicy
}

function defaultDshHome(): string {
  const configured = process.env.DSH_HOME
  return configured === undefined || configured === '' ? join(homedir(), '.dsh') : resolve(configured)
}

const DEFAULT_STATE_ROOT = join(defaultDshHome(), 'plugins', 'dsh-worktree')

export const Config: z<Config> = z.object({
  providerName: z.string().default('worktree'),
  managedRoot: z.string().default(join(DEFAULT_STATE_ROOT, 'checkouts')),
  journalPath: z.string().default(join(DEFAULT_STATE_ROOT, 'operations.jsonl')),
  sourceMode: z.union(['head', 'working-state', 'fresh'] as const).default('working-state'),
  sourceRemote: z.string(),
  sourceRef: z.string(),
  lifetime: z.union(['ephemeral', 'managed', 'permanent'] as const).default('managed'),
})

function absoluteConfigPath(label: string, value: string): string {
  if (value === '') throw new WorktreeError(`${label} must not be empty`, 'WORKTREE_CONFIG_PATH_EMPTY')
  return isAbsolute(value) ? resolve(value) : resolve(value)
}

function sourcePolicy(config: Config): SourcePolicy {
  switch (config.sourceMode) {
    case 'working-state':
      return { kind: 'working-state', includeIgnored: 'allowlist' }
    case 'head':
      return config.sourceRef === undefined ? { kind: 'head' } : { kind: 'head', ref: config.sourceRef }
    case 'fresh':
      return {
        kind: 'fresh',
        ...config.sourceRemote === undefined ? {} : { remote: config.sourceRemote },
        ...config.sourceRef === undefined ? {} : { ref: config.sourceRef },
      }
  }
}

/** Register the shared manager and DSH subagent provider. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const options: WorktreeManagerOptions = {
    managedRoot: absoluteConfigPath('managedRoot', config.managedRoot),
    journalPath: absoluteConfigPath('journalPath', config.journalPath),
  }
  const manager = new LocalWorktreeManager(options)
  const recovery = await manager.recover()
  for (const item of recovery.manual) {
    ctx.logger.warn(`dsh-worktree: manual recovery required for ${item.id}: ${item.reason}`)
  }
  ctx.provide('worktrees', manager)
  ctx.effect(() => async () => manager.close(), 'dsh-worktree.close')
  ctx.subagents.registerProvider(new WorktreeSubagentProvider(
    config.providerName,
    manager,
    startInProcessRun,
    { source: sourcePolicy(config), lifetime: config.lifetime },
  ))
}

export {
  WorktreeChangedError,
  WorktreeChangedSinceInspectionError,
  WorktreeError,
  WorktreeNotFoundError,
} from './errors.js'
export { LocalWorktreeManager } from './manager.js'
export { WorktreeSubagentProvider } from './provider.js'
export type { InProcessRunStarter, WorktreeProviderPolicy } from './provider.js'
export type {
  ConcludeWorktreeRequest,
  CreateWorktreeRequest,
  LifetimePolicy,
  SourcePolicy,
  WorktreeChanges,
  WorktreeBoundary,
  WorktreeId,
  WorktreeManager,
  WorktreeManagerOptions,
  WorktreeRecoveryReport,
  WorktreeState,
  WorktreeView,
} from './types.js'

/**
 * Create the durable local worktree module used by DSH plugins and standalone callers.
 * @param options - Managed filesystem and journal locations.
 * @returns A lifecycle owner for worktrees recorded in the configured journal.
 */
export function createWorktreeManager(options: WorktreeManagerOptions): WorktreeManager {
  return new LocalWorktreeManager(options)
}
