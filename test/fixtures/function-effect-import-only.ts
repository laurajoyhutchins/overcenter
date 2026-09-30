import { performGitHubPullRequestUpdateBranchEffect } from '../../src/providers/github/pr-update-branch-effect.ts';
import { performGitHubCommitStatusEffect } from '../../src/providers/github/status-effect.ts';
import { performPreparedSourceIntegration } from '../../src/source/source-integration.ts';

void performGitHubCommitStatusEffect;
void performGitHubPullRequestUpdateBranchEffect;
void performPreparedSourceIntegration;
