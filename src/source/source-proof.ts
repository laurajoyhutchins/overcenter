import type { GitHubJsonGet } from '../providers/github/rest.ts';
import { observeGitHubSourceProof } from './github-source-proof-observation.ts';
import {
  admitSourceProofObservation,
  type TrustedSourceProofWitness,
} from './source-proof-admission.ts';
import type { SourceProofContext } from './source-proof-record.ts';
import type { SourceTransactionPlan } from './transaction.ts';

export {
  admitSourceProofObservation,
  SourceProofRejected,
  trustedSourceProof,
  validateAdmittedSourceProof,
} from './source-proof-admission.ts';
export type { TrustedSourceProofWitness } from './source-proof-admission.ts';
export type { AdmittedSourceProof } from './source-proof-record.ts';

/**
 * Compatibility facade for the historical GitHub-backed source-proof API.
 *
 * Provider observation happens before authority admission. New authority code
 * should consume an already-realized observation through
 * admitSourceProofObservation().
 */
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
  const observation = observeGitHubSourceProof(githubToken, {
    repositoryId: context.repository_id,
    repositoryFullName: context.repository_full_name,
    workflowRunId: expectedWorkflowRunId,
    workflowRunAttempt: expectedWorkflowRunAttempt,
    get,
  });
  return admitSourceProofObservation(plan, record, {
    observation,
    expectedWorkflowRunId,
    expectedWorkflowRunAttempt,
    context,
  });
}
