import type { PullRequestEnsureRequest, PullRequestEnsureResult, PullRequestPublisher } from './types.js';
/** Idempotent GitHub adapter backed by an already-authenticated `gh` CLI. */
export declare class GitHubCliPullRequestPublisher implements PullRequestPublisher {
    readonly kind = "github-cli";
    ensure(request: PullRequestEnsureRequest): Promise<PullRequestEnsureResult>;
}
//# sourceMappingURL=forge.d.ts.map