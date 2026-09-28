import { performGitHubPullRequestUpdateBranchEffect } from '../../src/providers/github/pr-update-branch-effect.ts';
import { performGitHubCommitStatusEffect } from '../../src/providers/github/status-effect.ts';
import { integrateVerifiedSourceCandidate } from '../../src/source/source-integration.ts';

void performGitHubCommitStatusEffect(null as never, null as never, {
  token: 'fixture',
});
void performGitHubPullRequestUpdateBranchEffect(null as never, null as never, {
  token: 'fixture',
});
void integrateVerifiedSourceCandidate('.', null, null as never, 'fixture', '0'.repeat(40), null, {
  performReservedMutation: (mutation) => mutation(),
});
