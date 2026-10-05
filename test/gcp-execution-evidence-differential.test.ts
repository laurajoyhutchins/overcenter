import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canonicalDigest } from '../src/digest.ts';
import {
  assuranceEvidenceDescriptorForRecipe,
  executionEvidenceRealizationFromRecipeObservation,
  type AssuranceEvidenceExecutionObservation,
  type AssuranceEvidenceRecipe,
} from '../src/execution/assurance-evidence-realization.ts';
import { compareExecutionEvidenceReceipts } from '../src/execution/assurance-evidence-descriptor.ts';
import {
  adaptGitHubExecutionEvidence,
  GITHUB_EXECUTION_EVIDENCE_RECORD_SCHEMA,
  type GitHubExecutionEvidenceObservation,
} from '../src/providers/github/execution-evidence-receipt.ts';
import type { CertifiedGitHubSemanticReadEvidence } from '../src/providers/github/certified-read.ts';
import {
  GcpRunnerExecutionEvidenceExecutor,
  adaptGcpExecutionEvidence,
  gcpExecutionEvidenceRequest,
  realizeExecutionEvidenceOnGcp,
  type GcpExecutionEvidenceExecutor,
} from '../src/providers/gcp/execution-evidence-receipt.ts';
import {
  deriveAssuranceEvidenceNeeds,
  type AssuranceEvidenceNeed,
} from '../src/source/assurance-evidence-needs.ts';
import type { TransactionAssurancePlan } from '../src/source/transaction-planner.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
const REVISION = git('rev-parse', 'HEAD');
const TREE = git('rev-parse', 'HEAD^{tree}');

function assuranceNeed(): AssuranceEvidenceNeed {
  const plan: TransactionAssurancePlan = {
    base_revision: REVISION,
    candidate_revision: REVISION,
    candidate_tree: TREE,
    model_sha256: '2'.repeat(64),
    dependency_sha256: '3'.repeat(64),
    changed_artifacts: ['src/authority/engine.ts'],
    impacts: [],
    proof_plans: [],
    evidence: [],
    evidence_frontiers: [
      {
        coordinate: `revision:${REVISION}`,
        revision: REVISION,
        model_sha256: '2'.repeat(64),
        dependency_sha256: '3'.repeat(64),
        baseline_sha256: null,
        required_propositions: ['exact-revision-effect'],
        candidates: [
          {
            evidence_id: 'authority-flow-proof',
            proposition_ids: ['exact-revision-effect'],
            obligation_ids: ['exact-revision-effect'],
            artifact_ids: ['src/authority/engine.ts'],
            package_scripts: ['test:authority-flow-analysis', 'typecheck'],
            uses_package_runtime: true,
          },
        ],
      },
    ],
    coverage_gaps: [],
    validation_mode: 'selective',
    baseline_id: null,
    baseline_sha256: null,
  };
  return deriveAssuranceEvidenceNeeds(plan)[0]!;
}

function certifiedEvidence(
  operationKey: 'workflow_run' | 'workflow_job',
  idParameter: 'run_id' | 'job_id',
  id: number,
): CertifiedGitHubSemanticReadEvidence {
  return {
    provider: 'github',
    api_version: '2022-11-28',
    schema_sha256: 'd'.repeat(64),
    schema_source_commit: 'e'.repeat(40),
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

function githubObservation(
  recipe: AssuranceEvidenceRecipe,
  result: 'satisfied' | 'unsatisfied',
): GitHubExecutionEvidenceObservation {
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
        recipe,
        executionObservation(recipe, result),
      ),
    },
  };
}

const githubExpected = {
  workflow_path: '.github/workflows/assurance-evidence.yml',
  job_name: 'Authority flow evidence',
};

function gcpExecutor(
  status = 0,
  overrides: NodeJS.ProcessEnv = {},
): GcpRunnerExecutionEvidenceExecutor {
  return new GcpRunnerExecutionEvidenceExecutor({
    repo: repoRoot,
    env: {
      RUNNER_NAME: 'overcenter-gcp-8001-build',
      TARGET_JOB_ID: '8001',
      TARGET_REPOSITORY: 'laurajoyhutchins/overcenter',
      ...overrides,
    },
    runScript: () => status,
  });
}

test('GitHub and GCP independently realize the same neutral recipe on success', async () => {
  const need = assuranceNeed();
  const request = gcpExecutionEvidenceRequest(need, repoRoot);
  const github = adaptGitHubExecutionEvidence(
    assuranceEvidenceDescriptorForRecipe(request.recipe),
    githubObservation(request.recipe, 'satisfied'),
    githubExpected,
  );
  const gcp = await realizeExecutionEvidenceOnGcp(need, gcpExecutor(0), repoRoot);

  assert.equal(gcp.state, 'observed');
  if (gcp.state !== 'observed') return;
  assert.deepEqual(compareExecutionEvidenceReceipts(github.receipt, gcp.receipt), {
    state: 'equivalent',
    receipt: github.receipt,
  });
  assert.deepEqual(request.recipe.scripts, ['test:authority-flow-analysis', 'typecheck']);
});

test('GitHub and GCP independently derive the same unsatisfied receipt', async () => {
  const need = assuranceNeed();
  const request = gcpExecutionEvidenceRequest(need, repoRoot);
  const github = adaptGitHubExecutionEvidence(
    assuranceEvidenceDescriptorForRecipe(request.recipe),
    githubObservation(request.recipe, 'unsatisfied'),
    githubExpected,
  );
  const gcp = await realizeExecutionEvidenceOnGcp(need, gcpExecutor(1), repoRoot);

  assert.equal(gcp.state, 'observed');
  if (gcp.state !== 'observed') return;
  assert.equal(gcp.receipt.observation.result, 'unsatisfied');
  assert.deepEqual(compareExecutionEvidenceReceipts(github.receipt, gcp.receipt), {
    state: 'equivalent',
    receipt: github.receipt,
  });
});

test('GCP runner metadata changes provenance but cannot change the receipt', async () => {
  const need = assuranceNeed();
  const first = await realizeExecutionEvidenceOnGcp(need, gcpExecutor(0), repoRoot);
  const second = await realizeExecutionEvidenceOnGcp(
    need,
    gcpExecutor(0, {
      RUNNER_NAME: 'overcenter-gcp-9002-build',
      TARGET_JOB_ID: '9002',
    }),
    repoRoot,
  );
  assert.equal(first.state, 'observed');
  assert.equal(second.state, 'observed');
  if (first.state !== 'observed' || second.state !== 'observed') return;
  assert.deepEqual(first.receipt, second.receipt);
  assert.notDeepEqual(first.provenance, second.provenance);
});

test('stale GCP execution observation fails closed', async () => {
  const need = assuranceNeed();
  const actual = gcpExecutor(0);
  const stale: GcpExecutionEvidenceExecutor = {
    async execute(request) {
      const observed = await actual.execute(request);
      return {
        ...observed,
        execution: {
          ...observed.execution,
          revision: 'f'.repeat(40),
        },
      };
    },
  };
  const result = await realizeExecutionEvidenceOnGcp(need, stale, repoRoot);
  assert.deepEqual(result, {
    state: 'evidence-failure',
    reason: 'stale-input',
    diagnostic: 'GCP_EXECUTION_EVIDENCE_STALE_INPUT',
  });
});

test('incomplete GCP execution observation fails closed', () => {
  const need = assuranceNeed();
  const request = gcpExecutionEvidenceRequest(need, repoRoot);
  const result = adaptGcpExecutionEvidence(request, {
    provider: 'gcp',
    runner_name: 'overcenter-gcp-1-build',
    job_id: '1',
    target_repository: 'laurajoyhutchins/overcenter',
    execution: {
      schema: 'overcenter-assurance-evidence-execution-observation/v1',
      need_id: need.need_id,
      need_sha256: request.need_sha256,
      revision: REVISION,
      recipe_sha256: request.recipe_sha256,
      attempts: [],
    },
  });
  assert.equal(result.state, 'evidence-failure');
  if (result.state !== 'evidence-failure') return;
  assert.equal(result.reason, 'incomplete-observation');
});

test('non-GCP runner context is transport failure, never authority evidence', async () => {
  const result = await realizeExecutionEvidenceOnGcp(
    assuranceNeed(),
    gcpExecutor(0, { RUNNER_NAME: 'ordinary-runner' }),
    repoRoot,
  );
  assert.equal(result.state, 'evidence-failure');
  if (result.state !== 'evidence-failure') return;
  assert.equal(result.reason, 'transport-failure');
  assert.match(result.diagnostic, /GCP_RUNNER_NAME_INVALID/);
});

test('substrate disagreement remains an evidence failure', async () => {
  const need = assuranceNeed();
  const request = gcpExecutionEvidenceRequest(need, repoRoot);
  const github = adaptGitHubExecutionEvidence(
    assuranceEvidenceDescriptorForRecipe(request.recipe),
    githubObservation(request.recipe, 'satisfied'),
    githubExpected,
  );
  const gcp = await realizeExecutionEvidenceOnGcp(need, gcpExecutor(1), repoRoot);
  assert.equal(gcp.state, 'observed');
  if (gcp.state !== 'observed') return;
  assert.deepEqual(compareExecutionEvidenceReceipts(github.receipt, gcp.receipt), {
    state: 'evidence-failure',
    reason: 'substrate-discrepancy',
  });
});

test('GCP workflow uses the #598 runner substrate and neutral realizer', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/assurance-evidence.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /runs-on: \[self-hosted, overcenter-gcp\]/);
  assert.match(workflow, /realize-assurance-evidence-need\.ts/);
  assert.doesNotMatch(workflow, /admit|authority.*decision|settle/i);
});

test('neutral recipe owner has no provider dependency', () => {
  const source = readFileSync(
    new URL('../src/execution/assurance-evidence-realization.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /providers\/(?:gcp|github)|Gcp|GCP|GitHub/);
});
