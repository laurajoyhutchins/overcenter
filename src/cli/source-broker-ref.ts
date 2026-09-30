import { sourceTransactionContextFromEnvironment } from '../source/transaction-baseline.ts';
import { writeFileSync } from 'node:fs';

import { brokerSourceProposalRevision } from '../source/source-broker.ts';
import { appendGitHubOutputs, commandOption } from './project-command-runtime.ts';

const runId = commandOption('--run-id');
const proposalSha = commandOption('--proposal-sha');
if (!runId) throw new Error('--run-id_REQUIRES_VALUE');
if (!proposalSha) throw new Error('--proposal-sha_REQUIRES_VALUE');

const result = brokerSourceProposalRevision(process.cwd(), runId, proposalSha, {
  authorityRef: process.env.OVERCENTER_PROJECT_AUTHORITY_REF ?? 'refs/overcenter/state',
  remote: process.env.OVERCENTER_PROJECT_REMOTE ?? 'origin',
  githubToken: process.env.GITHUB_TOKEN ?? null,
  transactionContext: sourceTransactionContextFromEnvironment(),
});
if (result.publication.state === 'CONFLICT') {
  throw new Error(`SOURCE_CANDIDATE_REF_CONFLICT:${result.publication.observed_sha}`);
}

const output = `${JSON.stringify(result, null, 2)}\n`;
const outputPath = commandOption('--output');
if (outputPath) writeFileSync(outputPath, output);
else process.stdout.write(output);

appendGitHubOutputs({
  authority_head: result.authority_head,
  candidate_sha: result.candidate.commit_sha,
  candidate_ref: result.publication.ref,
  publication_state: result.publication.state,
});
