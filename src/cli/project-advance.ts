import { advanceProjectForAgent } from '../authority/project-agent-protocol.ts';
import { DEFAULT_PROJECT_GRAPH_PRODUCERS } from '../authority/default-project-graph.ts';
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
  graphProducers: DEFAULT_PROJECT_GRAPH_PRODUCERS,
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
  dispatch_route: receipt.dispatch?.route ?? '',
  dispatch_reason_code: receipt.dispatch?.reason_code ?? '',
  dispatch_evidence_predicates: JSON.stringify(receipt.dispatch?.evidence_predicates ?? []),
  receipt_digest: receipt.receipt_digest,
});
