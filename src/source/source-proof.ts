import type { GitHubJsonGet } from '../providers/github/rest.ts';
import { observeGitHubSourceProofExecutionEvidence } from '../providers/github/source-proof-execution-evidence.ts';
import {
  admitSourceProofEvidence,
  type TrustedSourceProofWitness,
} from './source-proof-admission.ts';
import type { SourceProofContext } from './source-proof-record.ts';
import type { SourceTransactionPlan } from './transaction.ts';

export {
  admitSourceProofEvidence,
  sourceProofExecutionEvidenceDescriptor,
  sourceProofExecutionEvidenceRealization,
  SourceProofRejected,
  trustedSourceProof,
  validateAdmittedSourceProof,
} from './source-proof-admission.ts';
export type { TrustedSourceProofWitness } from './source-proof-admission.ts';
export type { AdmittedSourceProof } from './source-proof-record.ts';

export function admitSourceProof(
  plan: SourceTransactionPlan,
  record: unknown,
  {
    githubToken,
    expectedWorkflowRunId,
    expectedWorkflowRunAttempt,
    context,
    get,
  }: {
    githubToken: string;
    expectedWorkflowRunId: number;
    expectedWorkflowRunAttempt: number;
    context: SourceProofContext;
    get: GitHubJsonGet;
  },
): TrustedSourceProofWitness {
  const executionEvidence = observeGitHubSourceProofExecutionEvidence(githubToken, plan, record, {
    workflowRunId: expectedWorkflowRunId,
    workflowRunAttempt: expectedWorkflowRunAttempt,
    get,
  });
  return admitSourceProofEvidence(plan, {
    executionEvidence,
    context,
  });
}
