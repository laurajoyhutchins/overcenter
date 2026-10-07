import { dispatchSourceValidation } from '../source/validation-dispatch.ts';
import { sourceTransactionContextFromEnvironment } from '../source/transaction-baseline.ts';
import { buildSourceTransactionPlan } from '../source/transaction.ts';
import { validateSourceAssignment } from '../source/source-obligation.ts';
import { readFileSync, writeFileSync } from 'node:fs';

import { brokerAssignedSourceProposal } from '../source/source-broker.ts';
import { appendGitHubOutputs, commandOption } from './project-command-runtime.ts';

const assignmentPath = commandOption('--assignment');
const proposalPath = commandOption('--proposal');
if (!assignmentPath) throw new Error('--assignment_REQUIRES_VALUE');
if (!proposalPath) throw new Error('--proposal_REQUIRES_VALUE');

const assignment = validateSourceAssignment(JSON.parse(readFileSync(assignmentPath, 'utf8')));
const proposal = JSON.parse(readFileSync(proposalPath, 'utf8'));
const context = sourceTransactionContextFromEnvironment();
const result = brokerAssignedSourceProposal(process.cwd(), assignment, proposal, {
  authorityRef: process.env.OVERCENTER_PROJECT_AUTHORITY_REF ?? 'refs/overcenter/state',
  remote: process.env.OVERCENTER_PROJECT_REMOTE ?? 'origin',
  githubToken: process.env.GITHUB_TOKEN ?? null,
});
const transactionPlan = buildSourceTransactionPlan({
  repo: process.cwd(),
  taskValue: assignment.task,
  claim: assignment.claim,
  candidateSha: result.candidate.commit_sha,
  context,
});
if (result.publication.state === 'CONFLICT') {
  throw new Error(`SOURCE_CANDIDATE_REF_CONFLICT:${result.publication.observed_sha}`);
}

if (process.env.OVERCENTER_DISPATCH_SOURCE_VALIDATION === '1') {
  dispatchSourceValidation(
    process.env.GITHUB_TOKEN ?? '',
    context.repository_full_name,
    result.publication,
    context.runtime_sha,
    transactionPlan.verification_profile.profile.workflow_path,
  );
}

const output = `${JSON.stringify({ ...result, transaction_plan: transactionPlan }, null, 2)}\n`;
const outputPath = commandOption('--output');
if (outputPath) writeFileSync(outputPath, output);
else process.stdout.write(output);

appendGitHubOutputs({
  authority_head: result.authority_head,
  candidate_sha: result.candidate.commit_sha,
  candidate_ref: result.publication.ref,
  publication_state: result.publication.state,
});
