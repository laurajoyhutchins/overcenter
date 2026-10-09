import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { advanceProjectForAgent } from '../authority/project-agent-protocol.ts';
import { projectGcpRunnerDemand } from '../providers/gcp/state-derived-runner-demand.ts';
import { GitOvercenterKernel } from '../storage/git-kernel.ts';
import { observeGitHubHostileMutationEvidence } from '../providers/github/hostile-mutation-evidence.ts';
import {
  appendGitHubOutputs,
  commandOption,
  projectCommandContext,
} from './project-command-runtime.ts';

const outputDir = commandOption('--output-dir');
if (!outputDir) {
  throw new Error('usage: project-advance.ts --output-dir <dir>');
}

const githubToken = process.env.GITHUB_TOKEN ?? null;
const receipt = advanceProjectForAgent(process.cwd(), projectCommandContext(), {
  outputDir,
  ...(process.env.OVERCENTER_WORKER_CLIENT === undefined
    ? {}
    : { workerClientPath: process.env.OVERCENTER_WORKER_CLIENT }),
  ...(process.env.OVERCENTER_PROJECT_AUTHORITY_REF === undefined
    ? {}
    : { authorityRef: process.env.OVERCENTER_PROJECT_AUTHORITY_REF }),
  ...(process.env.OVERCENTER_PROJECT_REMOTE === undefined
    ? {}
    : { remote: process.env.OVERCENTER_PROJECT_REMOTE }),
  githubToken,
  observationContext: {
    githubToken,
    ...(githubToken
      ? {
          observeGitHubHostileMutationEvidence: (postcondition) =>
            observeGitHubHostileMutationEvidence(githubToken, postcondition),
        }
      : {}),
  },
});
console.log(JSON.stringify(receipt, null, 2));

appendGitHubOutputs({
  state: receipt.state,
  authority_head: receipt.authority_head,
  obligation_id: receipt.obligation_id ?? '',
  run_id: receipt.run_id ?? '',
  claimed_revision: receipt.claimed_revision ?? '',
  assignment_sha256: receipt.assignment_sha256 ?? '',
  candidate_branch: receipt.candidate_branch ?? '',
  candidate_branch_base_sha: receipt.candidate_branch_base_sha ?? '',
  receipt_digest: receipt.receipt_digest,
});

/*
 * Optional, source-bound GCP infrastructure status for the existing
 * project.advance command. The project policy file is controlled by the
 * source-revision admission path, not by an agent-issued resize operation.
 * This observation never publishes runner leases or changes provider state.
 */
const demandPolicyPath = join(process.cwd(), '.overcenter', 'gcp-runner-demand-policy.json');
if (existsSync(demandPolicyPath)) {
  // This command can manage a foreign project's source revision. Never
  // project GCP authority from the command implementation checkout in
  // place of that project's actual source.
  const projectSource = process.env.OVERCENTER_PROJECT_SOURCE_SHA;
  const commandSource = process.env.OVERCENTER_COMMAND_SOURCE_SHA;
  let demand:
    | ReturnType<typeof projectGcpRunnerDemand>
    | {
        state: 'hold';
        reason: 'FOREIGN_PROJECT_POLICY_UNAVAILABLE' | 'DEMAND_OBSERVER_UNAVAILABLE';
        effect_authorized: false;
      };
  if (projectSource && projectSource !== commandSource) {
    demand = {
      state: 'hold',
      reason: 'FOREIGN_PROJECT_POLICY_UNAVAILABLE',
      effect_authorized: false,
    };
  } else {
    try {
      const authority = new GitOvercenterKernel(process.cwd(), {
        ref: process.env.OVERCENTER_PROJECT_AUTHORITY_REF ?? 'refs/overcenter/state',
        remote: process.env.OVERCENTER_PROJECT_REMOTE ?? null,
        githubToken,
      });
      demand = projectGcpRunnerDemand(
        authority,
        JSON.parse(readFileSync(demandPolicyPath, 'utf8')) as unknown,
      );
    } catch {
      // A diagnostic observation must not turn a successfully committed
      // project.advance claim into a failed command with a missing receipt.
      demand = {
        state: 'hold',
        reason: 'DEMAND_OBSERVER_UNAVAILABLE',
        effect_authorized: false,
      };
    }
  }
  console.log(JSON.stringify({ event: 'gcp_runner_demand', ...demand }));
  appendGitHubOutputs({
    gcp_runner_demand_state: demand.state,
    gcp_runner_authority_head:
      'authority_head' in demand ? (demand.authority_head ?? '') : '',
    gcp_runner_capacity: demand.state === 'projected' ? demand.capacity_needed : 'hold',
    gcp_runner_effect_authorized: false,
  });
}
