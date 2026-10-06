import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canonicalDigest, canonicalJson } from '../src/digest.ts';
import {
  executionEvidenceReceiptFromRecipeObservation,
  executionEvidenceRealizationFromRecipeObservation,
  type AssuranceEvidenceExecutionObservation,
  type AssuranceEvidenceRecipe,
} from '../src/execution/assurance-evidence-realization.ts';
import {
  assuranceEvidenceExecutorSet,
  realizeAssuranceEvidenceNeed,
  type AssuranceEvidenceExecutionSubstrates,
} from '../src/execution/assurance-evidence-execution.ts';
import type { ExecutionEvidenceReceipt } from '../src/execution/evidence-receipt.ts';
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
import {
  GITHUB_EXECUTION_EVIDENCE_RECORD_SCHEMA,
  type GitHubExecutionEvidenceObservation,
} from '../src/providers/github/execution-evidence-receipt.ts';
import {
  ASSURANCE_EVIDENCE_NEED_SCHEMA,
  type AssuranceEvidenceNeed,
} from '../src/source/assurance-evidence-needs.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const REVISION = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();

const identity = { evidence_id: 'authority-flow-proof', revision: REVISION };
const inputs = {
  coordinate: `revision:${REVISION}`,
  model_sha256: 'e'.repeat(64),
  dependency_sha256: 'f'.repeat(64),
  proposition_ids: canonicalJson(['exact-revision-effect']),
  obligation_ids: canonicalJson(['exact-revision-effect']),
  artifact_ids: canonicalJson(['src/authority/engine.ts']),
  package_scripts: canonicalJson(['test:authority-flow-analysis', 'typecheck']),
  uses_package_runtime: 'true',
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

function executionObservation(
  recipe: AssuranceEvidenceRecipe,
  result: 'satisfied' | 'unsatisfied',
): AssuranceEvidenceExecutionObservation {
  return {
    schema: 'overcenter-assurance-evidence-execution-observation/v1',
    need_id: recipe.need.need_id,
    need_sha256: recipe.need_sha256,
    revision: recipe.need.identity.revision,
    recipe_sha256: canonicalDigest(recipe),
    attempts:
      result === 'satisfied'
        ? recipe.scripts.map((script) => ({ script, exit_code: 0 }))
        : [{ script: recipe.scripts[0]!, exit_code: 1 }],
  };
}

function request() {
  return gcpExecutionEvidenceRequest(need, repoRoot);
}

function canonicalReceipt(
  result: 'satisfied' | 'unsatisfied' = 'satisfied',
): ExecutionEvidenceReceipt {
  const current = request();
  return executionEvidenceReceiptFromRecipeObservation(
    current.recipe,
    executionObservation(current.recipe, result),
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
  result: 'satisfied' | 'unsatisfied' = 'satisfied',
): GitHubExecutionEvidenceObservation {
  const current = request();
  const runId = 7001;
  const jobId = 8001;
  return {
    workflow_run: {
      state: 'observed',
      value: {
        id: runId,
        run_attempt: 1,
        head_sha: REVISION,
        path: '.github/workflows/assurance-evidence.yml',
        status: 'completed',
        conclusion: 'success',
      },
      evidence: certifiedEvidence('workflow_run', 'run_id', runId),
    },
    workflow_job: {
      state: 'observed',
      value: {
        id: jobId,
        run_id: runId,
        run_attempt: 1,
        head_sha: REVISION,
        name: 'Authority flow evidence',
        status: 'completed',
        conclusion: 'success',
      },
      evidence: certifiedEvidence('workflow_job', 'job_id', jobId),
    },
    record: {
      schema: GITHUB_EXECUTION_EVIDENCE_RECORD_SCHEMA,
      producer: {
        repository_id: 42,
        repository_full_name: 'acme/widget',
        workflow_run_id: runId,
        workflow_run_attempt: 1,
        workflow_job_id: jobId,
        workflow_path: '.github/workflows/assurance-evidence.yml',
        job_name: 'Authority flow evidence',
      },
      realization: executionEvidenceRealizationFromRecipeObservation(
        current.recipe,
        executionObservation(current.recipe, result),
      ),
    },
  };
}

function gcpObservation(
  result: 'satisfied' | 'unsatisfied' = 'satisfied',
) {
  const current = request();
  return {
    provider: 'gcp' as const,
    runner_name: 'overcenter-gcp-8001-build',
    job_id: '8001',
    target_repository: 'laurajoyhutchins/overcenter',
    execution: executionObservation(current.recipe, result),
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
          observation: githubObservation(),
          expected: {
            workflow_path: '.github/workflows/assurance-evidence.yml',
            job_name: 'Authority flow evidence',
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
      observation: {
        ...gcpObservation(),
        execution: { ...gcpObservation().execution, revision: '9'.repeat(40) },
      },
    },
    {
      name: 'identity-mismatch',
      observation: {
        ...gcpObservation(),
        execution: { ...gcpObservation().execution, need_id: 'assurance-evidence:wrong' },
      },
    },
    {
      name: 'incomplete-observation',
      observation: {
        ...gcpObservation(),
        execution: { ...gcpObservation().execution, attempts: [] },
      },
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
            observation: githubObservation(),
            expected: {
              workflow_path: '.github/workflows/assurance-evidence.yml',
              job_name: 'Authority flow evidence',
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
  const detached = structuredClone(canonicalReceipt());
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
