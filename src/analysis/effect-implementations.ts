import {
  GITHUB_COMMIT_STATUS_EFFECT,
  GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
  GITHUB_SOURCE_INTEGRATION_EFFECT,
} from '../effect-adapter.ts';

export const EFFECT_IMPLEMENTATION_BINDINGS = [
  {
    effect_contract: GITHUB_COMMIT_STATUS_EFFECT,
    path: 'src/providers/github/status-effect.ts',
    symbol: 'performGithubCommitStatusEffect',
  },
  {
    effect_contract: GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
    path: 'src/providers/github/pr-update-branch-effect.ts',
    symbol: 'performGithubPullRequestUpdateBranchEffect',
  },
  {
    effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
    path: 'src/source/source-integration.ts',
    symbol: 'brokerSourceProposal',
  },
  {
    effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
    path: 'src/source/source-integration.ts',
    symbol: 'integrateVerifiedSourceCandidate',
  },
] as const;

export type RegisteredEffectImplementationContract =
  (typeof EFFECT_IMPLEMENTATION_BINDINGS)[number]['effect_contract'];
