import { githubGet } from '../src/providers/github/rest.ts';
import { githubRepositoryPath } from '../src/providers/github/evidence-primitives.ts';
import { isData, isPositiveSafeInteger } from '../src/validation.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalDigest } from '../src/digest.ts';
import { GitOvercenterKernel } from '../src/storage/git-kernel.ts';
import { observeRepositoryDelta } from '../src/source/repository-delta.ts';
import {
  baselineSourceTransactionPlan,
  sourceTransactionContextFromEnvironment,
} from '../src/source/transaction-baseline.ts';
import { sourceProofRecord } from '../src/source/source-proof-record.ts';
import { validateSourceTransactionPlan } from '../src/source/transaction.ts';

const repo = process.cwd();
const runId = process.env.CANDIDATE_RUN_ID ?? '';
const candidateSha = process.env.CANDIDATE_SHA ?? '';
const kernel = new GitOvercenterKernel(repo, {
  ref: process.env.OVERCENTER_PROJECT_AUTHORITY_REF ?? 'refs/overcenter/state',
});
const binding = kernel.sourceTransaction(runId);
if (!binding) throw new Error('SOURCE_TRANSACTION_RECORD_BINDING_MISSING');
const plan = validateSourceTransactionPlan(binding.plan);
if (plan.candidate_sha !== candidateSha)
  throw new Error('SOURCE_TRANSACTION_RECORD_BINDING_MISMATCH');
const context = sourceTransactionContextFromEnvironment();
if (
  context.repository_id !== plan.repository_id ||
  context.repository_full_name !== plan.repository_full_name ||
  context.runtime_sha !== plan.runtime_sha
)
  throw new Error('SOURCE_TRANSACTION_RECORD_CONTEXT_MISMATCH');
const delta = observeRepositoryDelta(repo, plan.claim.source_sha, candidateSha);
const assurance = baselineSourceTransactionPlan(repo, delta, context);
if (
  canonicalDigest(assurance) !== canonicalDigest(plan.assurance) ||
  assurance.validation_mode !== 'baseline'
)
  throw new Error('SOURCE_TRANSACTION_RECORD_BASELINE_MISMATCH');
const jobResponse = githubGet(
  process.env.GITHUB_TOKEN ?? '',
  githubRepositoryPath(
    context.repository_full_name,
    `/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`,
  ),
);
const matches =
  isData(jobResponse) && Array.isArray(jobResponse.jobs)
    ? jobResponse.jobs.filter((job) => isData(job) && job.name === 'Record source verification')
    : [];
if (matches.length !== 1 || !isData(matches[0]) || !isPositiveSafeInteger(matches[0].id))
  throw new Error('SOURCE_PROOF_RECORD_JOB_UNAVAILABLE');
const record = sourceProofRecord(
  plan,
  {
    workflow_run_id: Number(process.env.GITHUB_RUN_ID),
    workflow_run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    job_id: matches[0].id,
  },
  process.env.EVIDENCE_RESULT ?? 'missing',
);
const directory = process.env.SOURCE_VERIFICATION_OUTPUT_DIR ?? 'source-verification';
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'source-verification.json'), `${JSON.stringify(record, null, 2)}\n`);
