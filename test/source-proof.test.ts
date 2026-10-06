import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../src/effect-adapter.ts';
import { executionEvidenceReceiptDigest } from '../src/execution/evidence-receipt.ts';
import { observeGitHubSourceProofExecutionEvidence } from '../src/providers/github/source-proof-execution-evidence.ts';
import {
  admitSourceProof,
  SourceProofRejected,
  trustedSourceProof,
} from '../src/source/source-proof.ts';
import { admitSourceProofEvidence } from '../src/source/source-proof-admission.ts';
import { sourceProofRecord, type SourceProofRecord } from '../src/source/source-proof-record.ts';
import {
  buildSourceTransactionPlan,
  sourceTransactionPlanDigest,
} from '../src/source/transaction.ts';
import { baselineSourceTransactionPlan } from '../src/source/transaction-baseline.ts';
import { observeRepositoryDelta } from '../src/source/repository-delta.ts';
import { readSourceVerificationProfile } from '../src/source/source-verification-profile.ts';

function repository() {
  return {
    id: 42,
    node_id: 'R_42',
    full_name: 'acme/widget',
    name: 'widget',
    owner: { login: 'acme' },
  };
}

function provider(
  candidateSha: string,
  runId: string,
  evidenceConclusion: 'success' | 'failure' = 'success',
) {
  const run = {
    id: 123,
    node_id: 'WFR_123',
    workflow_id: 88,
    run_number: 12,
    run_attempt: 2,
    name: 'Source verification',
    path: '.github/workflows/agent-candidate-signal.yml',
    head_sha: candidateSha,
    head_branch: `overcenter/candidate/${runId}`,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: evidenceConclusion,
    created_at: '2026-10-05T18:00:00Z',
    updated_at: '2026-10-05T18:05:00Z',
    repository: { id: 42 },
    head_repository: { id: 42 },
  };
  const evidenceJob = {
    id: 10,
    run_id: 123,
    run_attempt: 2,
    node_id: 'WFRJ_10',
    head_sha: candidateSha,
    name: 'Verify source candidate / Candidate evidence',
    status: 'completed',
    conclusion: evidenceConclusion,
    started_at: '2026-10-05T18:01:00Z',
    completed_at: '2026-10-05T18:04:00Z',
  };
  const recordJob = {
    id: 11,
    run_id: 123,
    run_attempt: 2,
    node_id: 'WFRJ_11',
    head_sha: candidateSha,
    name: 'Record source verification',
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-10-05T18:04:00Z',
    completed_at: '2026-10-05T18:05:00Z',
  };
  return (_token: string, path: string): unknown => {
    if (path === '/repos/acme/widget') return repository();
    if (path.endsWith('/actions/runs/123')) return run;
    if (path.endsWith('/actions/jobs/11')) return recordJob;
    if (path.endsWith('/attempts/2/jobs?per_page=100')) {
      return { jobs: [evidenceJob, recordJob] };
    }
    throw new Error(`unexpected provider path:${path}`);
  };
}

test('source admission consumes only canonical neutral execution evidence', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'overcenter-source-proof-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Proof');
  git('config', 'user.email', 'proof@local');
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(repo, '.github/workflows/agent-candidate-signal.yml'), 'trusted producer');
  writeFileSync(join(repo, 'baseline.txt'), 'independent checks');
  mkdirSync(join(repo, '.overcenter'), { recursive: true });
  writeFileSync(
    join(repo, '.overcenter/source-verification-profile.json'),
    `${JSON.stringify(
      {
        schema: 'overcenter-source-verification-profile/v1',
        id: 'fixture',
        workflow_path: '.github/workflows/agent-candidate-signal.yml',
        required_evidence_jobs: ['Verify source candidate / Candidate evidence'],
        record_job: 'Record source verification',
        commands: ['npm run lint', 'npm run typecheck', 'npm run test:unit'],
        protected_paths: ['.github', '.overcenter', 'baseline.txt'],
        baseline_test_roots: ['test'],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(repo, 'value.ts'), 'export const value = 1;');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');

  const context = {
    repository_id: 42,
    repository_full_name: 'acme/widget',
    runtime_sha: 'a'.repeat(40),
  };
  writeFileSync(join(repo, 'value.ts'), 'export const value = 2;');
  git('add', '-A');
  git('commit', '-qm', 'candidate');
  const candidate = git('rev-parse', 'HEAD');
  const claim = {
    run_id: 'source-run',
    obligation_key: 'key',
    claimed_revision: 'authority',
    source_sha: base,
  };
  const plan = buildSourceTransactionPlan({
    repo,
    taskValue: {
      schema: 'overcenter-source-task/v1',
      kind: 'source-change',
      objective: 'Update value',
      writable_paths: ['value.ts'],
      effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
    },
    claim,
    candidateSha: candidate,
    context,
  });
  const producer = { workflow_run_id: 123, workflow_run_attempt: 2, job_id: 11 };
  const record = sourceProofRecord(plan, producer, 'success');
  const admittedContext = {
    ...context,
    verification_profile_id: plan.verification_profile.profile.id,
    verification_profile_sha256: plan.verification_profile.sha256,
  };
  const get = provider(candidate, claim.run_id);
  const executionEvidence = observeGitHubSourceProofExecutionEvidence('fixture', plan, record, {
    workflowRunId: 123,
    workflowRunAttempt: 2,
    get,
  });
  const neutralWitness = admitSourceProofEvidence(plan, {
    executionEvidence,
    context: admittedContext,
  });
  const compatibilityWitness = admitSourceProof(plan, record, {
    githubToken: 'fixture',
    expectedWorkflowRunId: 123,
    expectedWorkflowRunAttempt: 2,
    context: admittedContext,
    get,
  });
  assert.deepEqual(trustedSourceProof(neutralWitness), trustedSourceProof(compatibilityWitness));
  const admitted = trustedSourceProof(neutralWitness);
  assert.equal(admitted.plan_digest, sourceTransactionPlanDigest(plan));
  assert.equal(
    admitted.execution_evidence_sha256,
    executionEvidenceReceiptDigest(executionEvidence),
  );
  assert.equal('producer' in admitted, false);

  assert.throws(
    () =>
      admitSourceProofEvidence(plan, {
        executionEvidence: {
          ...executionEvidence,
          identity: { ...executionEvidence.identity, revision: base },
        },
        context: admittedContext,
      }),
    /SOURCE_PROOF_EXECUTION_EVIDENCE_MISMATCH/,
  );

  const rejectedRecord = sourceProofRecord(plan, producer, 'failure');
  const rejectedEvidence = observeGitHubSourceProofExecutionEvidence(
    'fixture',
    plan,
    rejectedRecord,
    {
      workflowRunId: 123,
      workflowRunAttempt: 2,
      get: provider(candidate, claim.run_id, 'failure'),
    },
  );
  assert.equal(rejectedEvidence.observation.result, 'unsatisfied');
  assert.throws(
    () =>
      admitSourceProofEvidence(plan, {
        executionEvidence: rejectedEvidence,
        context: admittedContext,
      }),
    SourceProofRejected,
  );
  assert.throws(
    () =>
      observeGitHubSourceProofExecutionEvidence('fixture', plan, rejectedRecord, {
        workflowRunId: 123,
        workflowRunAttempt: 2,
        get: provider(candidate, claim.run_id, 'success'),
      }),
    /SOURCE_PROOF_JOB_INVALID|GITHUB_EXECUTION_NOT_SUCCESSFUL/,
  );

  writeFileSync(join(repo, 'baseline.txt'), 'weakened checks');
  git('add', '-A');
  git('commit', '-qm', 'weakened validator');
  const changed = git('rev-parse', 'HEAD');
  assert.equal(
    baselineSourceTransactionPlan(
      repo,
      observeRepositoryDelta(repo, base, changed),
      readSourceVerificationProfile(repo, base).profile,
    ).validation_mode,
    'unsupported',
  );
  assert.equal((record as SourceProofRecord).schema_version, 3);
});

test('authority source path contains no provider execution plumbing', () => {
  const admissionSource = readFileSync(
    new URL('../src/source/source-proof-admission.ts', import.meta.url),
    'utf8',
  );
  const requirementSource = readFileSync(
    new URL('../src/source/source-proof-evidence.ts', import.meta.url),
    'utf8',
  );
  const protocolSource = readFileSync(
    new URL('../src/authority/project-agent-protocol.ts', import.meta.url),
    'utf8',
  );
  for (const source of [admissionSource, requirementSource]) {
    assert.doesNotMatch(
      source,
      /GitHub|github|workflow_run|workflow_job|workflow_path|job_id|providers\/github/,
    );
  }
  assert.doesNotMatch(
    protocolSource,
    new RegExp(
      [
        'candidate_workflow_run_id',
        'candidate_workflow_run_attempt',
        'githubGet',
        'sourceVerificationPath',
        'source-proof-execution-evidence',
      ].join('|'),
    ),
  );
  assert.match(protocolSource, /sourceExecutionEvidence/);
  assert.match(protocolSource, /admitSourceProofEvidence/);
});
