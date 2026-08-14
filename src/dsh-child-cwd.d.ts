// Development builds currently compile against the latest published DSH
// packages while the provider-prepared cwd contract is landing upstream.
// These declarations exactly match that submitted public interface; the
// package peer range prevents supported runtime installation on older builds.
import '@deepseek-ai/dsh-subagent'
import '@deepseek-ai/dsh-subagent-in-process-driver'

declare module '@deepseek-ai/dsh-subagent' {
  interface ContinuableCreateSpec {
    readonly cwd?: string
  }
}

declare module '@deepseek-ai/dsh-subagent-in-process-driver' {
  interface InProcessRunOptions {
    readonly cwd?: string
  }
}
