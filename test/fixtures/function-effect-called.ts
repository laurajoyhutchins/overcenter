import { performGithubPullRequestUpdateBranchEffect } from '../../src/providers/github/pr-update-branch-effect.ts';
import { performGithubCommitStatusEffect } from '../../src/providers/github/status-effect.ts';
import { integrateVerifiedSourceCandidate } from '../../src/source/source-integration.ts';

void performGithubCommitStatusEffect(null as never, null as never, {
  token: 'fixture',
});
void performGithubPullRequestUpdateBranchEffect(null as never, null as never, {
  token: 'fixture',
});
void integrateVerifiedSourceCandidate(
  '.',
  null,
  null as never,
  'fixture',
  '0'.repeat(40),
  null,
  { performReservedMutation: (mutation) => mutation() },
);
