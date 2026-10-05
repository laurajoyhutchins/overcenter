import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  submitProjectCandidate,
  type ProjectSubmitContext,
} from '../authority/project-agent-protocol.ts';
import type { ExecutionEvidenceReceipt } from '../execution/evidence-receipt.ts';
import {
  observeGitHubSourceProofExecutionEvidence,
} from '../providers/github/source-proof-execution-evidence.ts';
import type { SourceTransactionPlan } from '../source/transaction.ts';
import {
  appendGitHubOutputs,
  commandOption,
  projectCommandContext,
  requiredEnv,
} from './project-command-runtime.ts';

const receiptPath = commandOption('--receipt');
if (!receiptPath) {
  throw new Error('usage: project-submit.ts --receipt <path>');
}

const context: ProjectSubmitContext = {
  ...projectCommandContext(),
  candidate_sha: requiredEnv('OVERCENTER_CANDIDATE_SHA'),
  candidate_run_id: requiredEnv('OVERCENTER_CANDIDATE_RUN_ID'),
};

const sourceVerificationPath = process.env.OVERCENTER_SOURCE_VERIFICATION_PATH;
const githubToken = process.env.GITHUB_TOKEN ?? null;
const sourceExecutionEvidence =
  sourceVerificationPath === undefined
    ? undefined
    : (plan: SourceTransactionPlan): ExecutionEvidenceReceipt => {
        if (!githubToken) throw new Error('SOURCE_PROOF_PRODUCER_CONTEXT_MISSING');
        const record: unknown = JSON.parse(readFileSync(sourceVerificationPath, 'utf8'));
        return observeGitHubSourceProofExecutionEvidence(githubToken, plan, record, {
          workflowRunId: Number(requiredEnv('OVERCENTER_CANDIDATE_WORKFLOW_RUN_ID')),
          workflowRunAttempt: Number(
            requiredEnv('OVERCENTER_CANDIDATE_WORKFLOW_RUN_ATTEMPT'),
          ),
        });
      };

const receipt = submitProjectCandidate(process.cwd(), context, {
  ...(process.env.OVERCENTER_PROJECT_AUTHORITY_REF === undefined
    ? {}
    : { authorityRef: process.env.OVERCENTER_PROJECT_AUTHORITY_REF }),
  ...(process.env.OVERCENTER_PROJECT_REMOTE === undefined
    ? {}
    : { remote: process.env.OVERCENTER_PROJECT_REMOTE }),
  githubToken,
  ...(sourceExecutionEvidence === undefined ? {} : { sourceExecutionEvidence }),
});
mkdirSync(dirname(receiptPath), { recursive: true });
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));

appendGitHubOutputs({
  disposition: receipt.disposition,
  verified: String(receipt.verified),
  authority_head: receipt.authority_head,
  obligation_id: receipt.obligation_id,
  run_id: receipt.run_id,
  settlement_commit: receipt.settlement_commit ?? '',
  integration_commit: receipt.integration_commit ?? '',
  already_settled: String(receipt.already_settled),
  receipt_digest: receipt.receipt_digest,
});
