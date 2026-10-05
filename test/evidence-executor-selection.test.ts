import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canonicalDigest } from '../src/digest.ts';
import { executionEvidenceDescriptorForAssuranceNeed } from '../src/execution/assurance-evidence-descriptor.ts';
import {
  assuranceEvidenceExecutorSet,
  realizeAssuranceEvidenceNeed,
  type AssuranceEvidenceExecutionSubstrates,
} from '../src/execution/assurance-evidence-execution.ts';
import {
  executionEvidenceReceipt,
  type ExecutionEvidenceReceipt,
} from '../src/execution/evidence-receipt.ts';
import {
  EVIDENCE_EXECUTOR_PREFERENCE,
  EvidenceExecutorUnavailable,
  realizeEvidenceNeedWithPreference,
} from '../src/execution/evidence-executor-selection.ts';
import {
  LOCAL_EVIDENCE_REALIZER_SCHEMA,
  type LocalEvidenceRealizationCache,
  type LocalEvidenceRealizerDescriptor,
} from '../src/execution/local-evidence-realization-cache.ts';
import { gcpExecutionEvidenceRequest } from '../src/providers/gcp/execution-evidence-receipt.ts';
import type { CertifiedGitHubSemanticReadEvidence } from '../src/providers/github/certified-read.ts';
import type { GitHubExecutionEvidenceObservation } from '../src/providers/github/execution-evidence-receipt.ts';
import {
  ASSURANCE_EVIDENCE_NEED_SCHEMA,
  type AssuranceEvidenceNeed,
} from '../src/source/assurance-evidence-needs.ts';

const REVISION = 'a'.repeat(40);
const OUTPUTS = { evidence_sha256: 'b'.repeat(64) };
const SEMANTIC_EVIDENCE = {
  'candidate.profile-executed': 'true',
  'candidate.revision-observed': REVISION,
};

const identity = { evidence_id: 'candidate-evidence', revision: REVISION };
const inputs = {
  base_revision: 'c'.repeat(40),
  candidate_tree: 'd'.repeat(40),
  model_sha256: 'e'.repeat(64),
  dependency_sha256: 'f'.repeat(64),
  changed_artifacts: '["src/a.ts"]',
  obligation_ids: '["candidate-proof"]',
  artifact_ids: '["proof/candidate.json"]',
};

const need: AssuranceEvidenceNeed = {
  schema: ASSURANCE_EVIDENCE_NEED_SCHEMA,
  need_id: `assurance-evidence:${canonicalDigest({
    schema: ASSURANCE_EVIDENCE_NEED_SCHEMA,
    identity,
    inputs,
  })}`,
  identity,
  inputs,
};

function canonicalReceipt(
  result: 'satisfied' | 'unsatisfied' = 'satisfied',
): ExecutionEvidenceReceipt {
  return executionEvidenceReceipt(
    executionEvidenceDescriptorForAssuranceNeed(need, OUTPUTS, SEMANTIC_EVIDENCE),
    result,
  );
}

class MemoryCache implements LocalEvidenceRealizationCache {
  readonly values = new Map<string, string>();

  read(inputIdentity: string): string | null {
    return this.values.get(inputIdentity) ?? null;
  }

  write(inputIdentity: string, serialized: string): void {
    this.values.set(inputIdentity, serialized);
  }
}

const realizer: LocalEvidenceRealizerDescriptor = {
  schema: LOCAL_EVIDENCE_REALIZER_SCHEMA,
  kind: 'deterministic-local',
  implementation_sha256: '1'.repeat(64),
  runtime_sha256: '2'.repeat(64),
  configuration_sha256: '3'.repeat(64),
};

function certifiedEvidence(
  operationKey: 'workflow_run' | 'workflow_job',
  idParameter: 'run_id' | 'job_id',
  id: number,
): CertifiedGitHubSemanticReadEvidence {
  return {
    provider: 'github',
    api_version: '2022-11-28',
    schema_sha256: '4'.repeat(64),
    schema_source_commit: '5'.repeat(40),
    observer: { kind: 'git-kernel', id: 'github-semantic-read/v1' },
    repository_id: 42,
    requested_repository_full_name: 'acme/widget',
    repository: {} as CertifiedGitHubSemanticReadEvidence['repository'],
    operation_key: operationKey,
    operation_id:
      operationKey === 'workflow_run'
        ? 'actions/get-workflow-run'
        : 'actions/get-job-for-workflow-run',
    observed_at: '2026-10-05T20:00:00.000Z',
    request_path: '/provider/path',
    parameters: { [idParameter]: id },
    required_permissions: ['actions:read'],
    collection: null,
    negative_evidence_authoritative: false,
    validated_paths: [],
    optional_absent_paths: [],
  };
}

function githubObservation(
  result: 'success' | 'failure' = 'success',
): GitHubExecutionEvidenceObservation {
  return {
    workflow_run: {
      id: 7001,
      run_attempt: 1,
      head_sha: REVISION,
      path: '.github/workflows/tests.yml',
      status: 'completed',
      conclusion: result,
    },
    workflow_job: {
      id: 8001,
      run_id: 7001,
      run_attempt: 1,
      head_sha: REVISION,
      name: 'Candidate evidence',
      status: 'completed',
      conclusion: result,
    },
    workflow_run_evidence: certifiedEvidence('workflow_run', 'run_id', 7001),
    workflow_job_evidence: certifiedEvidence('workflow_job', 'job_id', 8001),
  };
}

function gcpObservation(result: 'satisfied' | 'unsatisfied' = 'satisfied') {
  const request = gcpExecutionEvidenceRequest(need);
  return {
    provider: 'gcp' as const,
    need_id: need.need_id,
    need_sha256: request.need_sha256,
    revision: REVISION,
    state: 'completed' as const,
    result,
    outputs: OUTPUTS,
    semantic_evidence: SEMANTIC_EVIDENCE,
    observed_at: '2026-10-05T20:00:01.000Z',
    execution_id: 'projects/p/locations/us-central1/executions/123',
  };
}

function completeSubstrates(events: string[] = []): AssuranceEvidenceExecutionSubstrates {
  return {
    local: {
      cache: new MemoryCache(),
      realizer,
      async realize() {
        events.push('local');
        return canonicalReceipt();
      },
    },
    gcp: {
      executor: {
        async execute() {
          events.push('gcp');
          return gcpObservation();
        },
      },
    },
    github: {
      async execute() {
        events.push('github');
        return {
          outputs: OUTPUTS,
          semantic_evidence: SEMANTIC_EVIDENCE,
          observation: githubObservation(),
          expected: {
            workflow_path: '.github/workflows/tests.yml',
            job_name: 'Candidate evidence',
          },
        };
      },
    },
  };
}

test('production preference is local, then GCP, then GitHub', async () => {
  const events: string[] = [];
  assert.deepEqual(EVIDENCE_EXECUTOR_PREFERENCE, ['local', 'gcp', 'github']);

  const receipt = await realizeAssuranceEvidenceNeed(need, completeSubstrates(events));
  assert.deepEqual(receipt, canonicalReceipt());
  assert.deepEqual(events, ['local']);
});

test('explicit local and GCP unavailability falls through to GitHub', async () => {
  const events: string[] = [];
  const substrates = completeSubstrates(events);
  substrates.local = {
    cache: new MemoryCache(),
    realizer,
    async realize() {
      events.push('local');
      throw new EvidenceExecutorUnavailable('LOCAL_RUNNER_UNAVAILABLE');
    },
  };
  substrates.gcp = {
    executor: {
      async execute() {
        events.push('gcp');
        throw new Error('GCP_TRANSPORT_UNAVAILABLE');
      },
    },
  };

  const receipt = await realizeAssuranceEvidenceNeed(need, substrates);
  assert.deepEqual(receipt, canonicalReceipt());
  assert.deepEqual(events, ['local', 'gcp', 'github']);
});

test('non-transport GCP evidence failures are terminal and cannot fall through', async () => {
  const cases = [
    {
      name: 'stale-input',
      observation: { ...gcpObservation(), revision: '9'.repeat(40) },
    },
    {
      name: 'identity-mismatch',
      observation: { ...gcpObservation(), need_id: 'assurance-evidence:wrong' },
    },
    {
      name: 'incomplete-observation',
      observation: { ...gcpObservation(), state: 'incomplete', result: undefined },
    },
  ];

  for (const fixture of cases) {
    let githubCalls = 0;
    const substrates: AssuranceEvidenceExecutionSubstrates = {
      local: {
        capability: () => 'unsupported',
        cache: new MemoryCache(),
        realizer,
        realize: () => canonicalReceipt(),
      },
      gcp: {
        executor: {
          execute: async () => fixture.observation,
        },
      },
      github: {
        async execute() {
          githubCalls += 1;
          return {
            outputs: OUTPUTS,
            semantic_evidence: SEMANTIC_EVIDENCE,
            observation: githubObservation(),
            expected: {
              workflow_path: '.github/workflows/tests.yml',
              job_name: 'Candidate evidence',
            },
          };
        },
      },
    };

    await assert.rejects(
      realizeAssuranceEvidenceNeed(need, substrates),
      new RegExp(`EVIDENCE_EXECUTION_INVALID:gcp:${fixture.name}:`),
    );
    assert.equal(githubCalls, 0, fixture.name);
  }
});

test('unsatisfied local evidence is semantic evidence and stops fallback', async () => {
  const events: string[] = [];
  const substrates = completeSubstrates(events);
  substrates.local = {
    cache: new MemoryCache(),
    realizer,
    async realize() {
      events.push('local');
      return canonicalReceipt('unsatisfied');
    },
  };

  const receipt = await realizeAssuranceEvidenceNeed(need, substrates);
  assert.equal(receipt.observation.result, 'unsatisfied');
  assert.deepEqual(events, ['local']);
});

test('forcing each real adapter yields the same canonical authority-facing receipt', async () => {
  const executors = assuranceEvidenceExecutorSet(completeSubstrates());

  const receipts = [];
  for (const substrate of EVIDENCE_EXECUTOR_PREFERENCE) {
    receipts.push(await realizeEvidenceNeedWithPreference(need, executors, [substrate]));
  }

  assert.deepEqual(receipts[0], canonicalReceipt());
  assert.deepEqual(receipts[1], receipts[0]);
  assert.deepEqual(receipts[2], receipts[0]);
});

test('receipt identity cannot be detached from the requested need', async () => {
  const detached = canonicalReceipt();
  detached.identity = {
    evidence_id: detached.identity.evidence_id,
    revision: '8'.repeat(40),
  };

  await assert.rejects(
    realizeAssuranceEvidenceNeed(need, {
      local: {
        cache: new MemoryCache(),
        realizer,
        realize: () => detached,
      },
    }),
    /EVIDENCE_EXECUTION_INVALID:local:LOCAL_EVIDENCE_RECEIPT_NEED_MISMATCH/,
  );
});

test('selection remains outside authority and the composition imports no authority layer', () => {
  const selector = readFileSync(
    new URL('../src/execution/evidence-executor-selection.ts', import.meta.url),
    'utf8',
  );
  const composition = readFileSync(
    new URL('../src/execution/assurance-evidence-execution.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(selector, /from ['"]\.\.\/authority\//);
  assert.doesNotMatch(selector, /from ['"]\.\.\/source\//);
  assert.doesNotMatch(composition, /from ['"]\.\.\/authority\//);
});
