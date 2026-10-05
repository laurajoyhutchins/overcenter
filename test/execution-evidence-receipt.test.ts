import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  executionEvidenceReceipt,
  executionEvidenceReceiptDigest,
  normalizeExecutionEvidenceReceipt,
  sameExecutionEvidenceReceipt,
  type ExecutionEvidenceDescriptor,
  type ExecutionEvidenceRealization,
} from '../src/execution/evidence-receipt.ts';
import {
  adaptGitHubExecutionEvidence,
  GITHUB_EXECUTION_EVIDENCE_RECORD_SCHEMA,
  type GitHubExecutionEvidenceObservation,
  type GitHubExecutionEvidenceRecord,
  type ObservedGitHubSemanticRead,
} from '../src/providers/github/execution-evidence-receipt.ts';
import { observeCertifiedGitHubSemanticRead } from '../src/providers/github/certified-read.ts';
import type { GitHubJsonGet } from '../src/providers/github/rest.ts';

const REVISION = 'a'.repeat(40);
const NEED = {
  id: `assurance-evidence:${'f'.repeat(64)}`,
  sha256: '9'.repeat(64),
};

const descriptor: ExecutionEvidenceDescriptor = {
  need: NEED,
  identity: { evidence_id: 'candidate-evidence', revision: REVISION },
  inputs: { source_sha: REVISION, profile_sha256: 'b'.repeat(64) },
};

function realization(
  result: 'satisfied' | 'unsatisfied',
  overrides: Partial<ExecutionEvidenceRealization> = {},
): ExecutionEvidenceRealization {
  return {
    ...descriptor,
    outputs: { evidence_sha256: 'c'.repeat(64) },
    semantic_evidence: {
      'candidate.profile-executed': 'true',
      'candidate.revision-observed': REVISION,
    },
    observation: { result },
    ...overrides,
  };
}

function repository() {
  return {
    id: 42,
    node_id: 'R_42',
    full_name: 'acme/widget',
    name: 'widget',
    owner: { login: 'acme' },
  };
}

function workflowRun(runId: number, overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    node_id: `WFR_${runId}`,
    workflow_id: 88,
    run_number: 12,
    run_attempt: 2,
    name: 'Candidate verification',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_sha: REVISION,
    head_branch: 'candidate',
    path: '.github/workflows/tests.yml',
    created_at: '2026-10-05T18:00:00Z',
    updated_at: '2026-10-05T18:05:00Z',
    ...overrides,
  };
}

function workflowJob(runId: number, jobId: number, overrides: Record<string, unknown> = {}) {
  return {
    id: jobId,
    run_id: runId,
    run_attempt: 2,
    node_id: `WFRJ_${jobId}`,
    head_sha: REVISION,
    name: 'Candidate evidence',
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-10-05T18:01:00Z',
    completed_at: '2026-10-05T18:04:00Z',
    ...overrides,
  };
}

function provider(
  runId: number,
  jobId: number,
  {
    run = workflowRun(runId),
    job = workflowJob(runId, jobId),
  }: {
    run?: unknown;
    job?: unknown;
  } = {},
): GitHubJsonGet {
  return (_token, path) => {
    if (path === '/repos/acme/widget') return repository();
    if (path === `/repos/acme/widget/actions/runs/${runId}`) return run;
    if (path === `/repos/acme/widget/actions/jobs/${jobId}`) return job;
    throw new Error(`unexpected provider path:${path}`);
  };
}

function observedRead(
  get: GitHubJsonGet,
  operation: 'workflow_run' | 'workflow_job',
  id: number,
): ObservedGitHubSemanticRead {
  const result = observeCertifiedGitHubSemanticRead('token', {
    repositoryId: 42,
    repositoryFullName: 'acme/widget',
    operation,
    parameters: operation === 'workflow_run' ? { run_id: id } : { job_id: id },
    grantedPermissions: ['actions:read'],
    get,
    clock: () => '2026-10-05T18:06:00.000Z',
  });
  assert.equal(result.state, 'observed');
  if (result.state !== 'observed') {
    throw new Error(
      result.state === 'indeterminate'
        ? result.observation_error
        : 'GITHUB_EXECUTION_EVIDENCE_UNEXPECTED_PAGE',
    );
  }
  return {
    state: 'observed',
    value: result.value,
    evidence: result.evidence,
  };
}

function record(
  runId: number,
  jobId: number,
  evidence: ExecutionEvidenceRealization,
  overrides: Partial<GitHubExecutionEvidenceRecord['producer']> = {},
): GitHubExecutionEvidenceRecord {
  return {
    schema: GITHUB_EXECUTION_EVIDENCE_RECORD_SCHEMA,
    producer: {
      repository_id: 42,
      repository_full_name: 'acme/widget',
      workflow_run_id: runId,
      workflow_run_attempt: 2,
      workflow_job_id: jobId,
      workflow_path: '.github/workflows/tests.yml',
      job_name: 'Candidate evidence',
      ...overrides,
    },
    realization: evidence,
  };
}

function observation({
  runId = 7001,
  jobId = 8001,
  run = workflowRun(runId),
  job = workflowJob(runId, jobId),
  evidence = realization('satisfied'),
  recordValue = record(runId, jobId, evidence),
}: {
  runId?: number;
  jobId?: number;
  run?: unknown;
  job?: unknown;
  evidence?: ExecutionEvidenceRealization;
  recordValue?: unknown;
} = {}): GitHubExecutionEvidenceObservation {
  const get = provider(runId, jobId, { run, job });
  return {
    workflow_run: observedRead(get, 'workflow_run', runId),
    workflow_job: observedRead(get, 'workflow_job', jobId),
    record: recordValue,
  };
}

const expected = {
  workflow_path: '.github/workflows/tests.yml',
  job_name: 'Candidate evidence',
};

test('canonical receipt normalization is deterministic and substrate-neutral', () => {
  const left = executionEvidenceReceipt(descriptor, realization('satisfied'));
  const right = normalizeExecutionEvidenceReceipt({
    schema: 'overcenter-execution-evidence-receipt/v1',
    semantic_evidence: {
      'candidate.revision-observed': REVISION,
      'candidate.profile-executed': 'true',
    },
    outputs: { evidence_sha256: 'c'.repeat(64) },
    inputs: { profile_sha256: 'b'.repeat(64), source_sha: REVISION },
    identity: { revision: REVISION, evidence_id: 'candidate-evidence' },
    need: { sha256: NEED.sha256, id: NEED.id },
    observation: { result: 'satisfied' },
  });

  assert.deepEqual(left, right);
  assert.equal(executionEvidenceReceiptDigest(left), executionEvidenceReceiptDigest(right));
  assert.equal(sameExecutionEvidenceReceipt(left, right), true);
  assert.equal(JSON.stringify(left).includes('github'), false);
  assert.deepEqual(Object.keys(descriptor), ['need', 'identity', 'inputs']);
});

test('receipt binds the immutable need and rejects stale realization claims', () => {
  assert.throws(
    () =>
      executionEvidenceReceipt(
        descriptor,
        realization('satisfied', {
          need: { ...NEED, sha256: '8'.repeat(64) },
        }),
      ),
    /EXECUTION_EVIDENCE_REALIZATION_BINDING_MISMATCH/,
  );
  assert.throws(
    () =>
      executionEvidenceReceipt(
        descriptor,
        realization('satisfied', {
          inputs: { ...descriptor.inputs, source_sha: 'd'.repeat(40) },
        }),
      ),
    /EXECUTION_EVIDENCE_REALIZATION_BINDING_MISMATCH/,
  );
});

test('GitHub transport identity can change without changing authority-facing evidence', () => {
  const first = adaptGitHubExecutionEvidence(descriptor, observation(), expected);
  const replay = adaptGitHubExecutionEvidence(
    descriptor,
    observation({ runId: 7002, jobId: 8002 }),
    expected,
  );

  assert.deepEqual(
    first.receipt,
    executionEvidenceReceipt(descriptor, realization('satisfied')),
  );
  assert.deepEqual(first.receipt, replay.receipt);
  assert.notDeepEqual(first.provenance, replay.provenance);
  assert.equal(first.provenance.provider, 'github');
  assert.equal(first.provenance.workflow_run_id, 7001);
  assert.equal(first.provenance.workflow_job_id, 8001);
});

test('GitHub success establishes execution completion, not semantic satisfaction', () => {
  const unsatisfied = adaptGitHubExecutionEvidence(
    descriptor,
    observation({ evidence: realization('unsatisfied') }),
    expected,
  );
  assert.equal(unsatisfied.receipt.observation.result, 'unsatisfied');

  assert.throws(
    () =>
      adaptGitHubExecutionEvidence(
        descriptor,
        observation({
          job: workflowJob(7001, 8001, { conclusion: 'failure' }),
          evidence: realization('unsatisfied'),
        }),
        expected,
      ),
    /GITHUB_EXECUTION_NOT_SUCCESSFUL/,
  );
});

test('GitHub result record is bound to the certified producer coordinates', () => {
  assert.throws(
    () =>
      adaptGitHubExecutionEvidence(
        descriptor,
        observation({
          recordValue: record(7001, 8001, realization('satisfied'), {
            workflow_job_id: 9001,
          }),
        }),
        expected,
      ),
    /GITHUB_EXECUTION_EVIDENCE_RECORD_PRODUCER_MISMATCH/,
  );
});

test('certified read value and certificate coordinate cannot be spliced', () => {
  const spliced = structuredClone(observation());
  spliced.workflow_job.evidence.parameters.job_id = 9001;
  assert.throws(
    () => adaptGitHubExecutionEvidence(descriptor, spliced, expected),
    /GITHUB_EXECUTION_EVIDENCE_CERTIFICATE_VALUE_MISMATCH/,
  );
});

test('GitHub adapter rejects execution identity drift before accepting realization', () => {
  assert.throws(
    () =>
      adaptGitHubExecutionEvidence(
        descriptor,
        observation({
          job: workflowJob(7001, 8001, { head_sha: 'e'.repeat(40) }),
        }),
        expected,
      ),
    /GITHUB_EXECUTION_EVIDENCE_IDENTITY_MISMATCH/,
  );

  assert.throws(
    () =>
      adaptGitHubExecutionEvidence(
        descriptor,
        observation({
          evidence: realization('satisfied', {
            identity: { ...descriptor.identity, revision: 'e'.repeat(40) },
          }),
          recordValue: record(
            7001,
            8001,
            realization('satisfied', {
              identity: { ...descriptor.identity, revision: 'e'.repeat(40) },
            }),
          ),
        }),
        expected,
      ),
    /EXECUTION_EVIDENCE_REALIZATION_BINDING_MISMATCH/,
  );
});

test('canonical receipt owner has no GitHub dependency', () => {
  const source = readFileSync(
    new URL('../src/execution/evidence-receipt.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /providers\/github|GitHub|workflow_run|workflow_job/);
  assert.doesNotMatch(source, /localeCompare/);
});
