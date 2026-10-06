import { resolve } from 'node:path';

import { canonicalDigest } from '../../digest.ts';
import {
  deriveAssuranceEvidenceRecipe,
  executionEvidenceReceiptFromRecipeObservation,
  observeAssuranceEvidenceRecipe,
  type AssuranceEvidenceExecutionObservation,
  type AssuranceEvidenceRecipe,
  type AssuranceEvidenceScriptRunner,
} from '../../execution/assurance-evidence-realization.ts';
import type { ExecutionEvidenceReceipt } from '../../execution/evidence-receipt.ts';
import type { AssuranceEvidenceNeed } from '../../source/assurance-evidence-needs.ts';
import { isData } from '../../validation.ts';

export interface GcpExecutionEvidenceRequest {
  need: AssuranceEvidenceNeed;
  need_sha256: string;
  recipe: AssuranceEvidenceRecipe;
  recipe_sha256: string;
}

export interface GcpExecutionEvidenceObservation {
  provider: 'gcp';
  runner_name: string;
  job_id: string;
  target_repository: string;
  execution: AssuranceEvidenceExecutionObservation;
}

export interface GcpExecutionEvidenceExecutor {
  execute(request: GcpExecutionEvidenceRequest): Promise<unknown>;
}

export interface GcpExecutionEvidenceProvenance {
  provider: 'gcp';
  runner_name: string;
  job_id: string;
  target_repository: string;
  need_sha256: string;
  recipe_sha256: string;
}

export type GcpExecutionEvidenceFailureReason =
  | 'transport-failure'
  | 'incomplete-observation'
  | 'identity-mismatch'
  | 'stale-input';

export type GcpExecutionEvidenceRealization =
  | {
      state: 'observed';
      receipt: ExecutionEvidenceReceipt;
      provenance: GcpExecutionEvidenceProvenance;
    }
  | {
      state: 'evidence-failure';
      reason: GcpExecutionEvidenceFailureReason;
      diagnostic: string;
    };

export function gcpExecutionEvidenceRequest(
  need: AssuranceEvidenceNeed,
  repo = process.cwd(),
): GcpExecutionEvidenceRequest {
  const recipe = deriveAssuranceEvidenceRecipe(repo, need);
  return {
    need: structuredClone(need),
    need_sha256: canonicalDigest(need),
    recipe,
    recipe_sha256: canonicalDigest(recipe),
  };
}

function evidenceFailure(
  reason: GcpExecutionEvidenceFailureReason,
  diagnostic: string,
): GcpExecutionEvidenceRealization {
  return { state: 'evidence-failure', reason, diagnostic };
}

function requiredString(value: unknown, error: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(error);
  return value;
}

function parseExecutionObservation(value: unknown): AssuranceEvidenceExecutionObservation {
  if (!isData(value) || !Array.isArray(value.attempts)) {
    throw new Error('GCP_EXECUTION_EVIDENCE_OBSERVATION_INCOMPLETE');
  }
  return {
    schema: requiredString(
      value.schema,
      'GCP_EXECUTION_EVIDENCE_OBSERVATION_INCOMPLETE',
    ) as AssuranceEvidenceExecutionObservation['schema'],
    need_id: requiredString(value.need_id, 'GCP_EXECUTION_EVIDENCE_OBSERVATION_INCOMPLETE'),
    need_sha256: requiredString(value.need_sha256, 'GCP_EXECUTION_EVIDENCE_OBSERVATION_INCOMPLETE'),
    revision: requiredString(value.revision, 'GCP_EXECUTION_EVIDENCE_OBSERVATION_INCOMPLETE'),
    recipe_sha256: requiredString(
      value.recipe_sha256,
      'GCP_EXECUTION_EVIDENCE_OBSERVATION_INCOMPLETE',
    ),
    attempts: value.attempts.map((attempt) => {
      if (!isData(attempt) || typeof attempt.script !== 'string') {
        throw new Error('GCP_EXECUTION_EVIDENCE_OBSERVATION_INCOMPLETE');
      }
      return {
        script: attempt.script,
        exit_code: Number(attempt.exit_code),
      };
    }),
  };
}

function runnerContext(
  env: NodeJS.ProcessEnv,
): Pick<GcpExecutionEvidenceObservation, 'runner_name' | 'job_id' | 'target_repository'> {
  const runnerName = requiredString(env.RUNNER_NAME, 'GCP_RUNNER_NAME_REQUIRED');
  const jobId = requiredString(env.TARGET_JOB_ID, 'GCP_RUNNER_JOB_ID_REQUIRED');
  const targetRepository = requiredString(env.TARGET_REPOSITORY, 'GCP_RUNNER_REPOSITORY_REQUIRED');
  if (!/^overcenter-gcp-[A-Za-z0-9_.-]+$/.test(runnerName)) {
    throw new Error('GCP_RUNNER_NAME_INVALID');
  }
  if (!/^\d+$/.test(jobId)) throw new Error('GCP_RUNNER_JOB_ID_INVALID');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepository)) {
    throw new Error('GCP_RUNNER_REPOSITORY_INVALID');
  }
  return {
    runner_name: runnerName,
    job_id: jobId,
    target_repository: targetRepository,
  };
}

export class GcpRunnerExecutionEvidenceExecutor implements GcpExecutionEvidenceExecutor {
  readonly repo: string;
  readonly env: NodeJS.ProcessEnv;
  readonly runScript: AssuranceEvidenceScriptRunner | undefined;

  constructor({
    repo = process.cwd(),
    env = process.env,
    runScript,
  }: {
    repo?: string;
    env?: NodeJS.ProcessEnv;
    runScript?: AssuranceEvidenceScriptRunner;
  } = {}) {
    this.repo = resolve(repo);
    this.env = env;
    this.runScript = runScript;
  }

  async execute(request: GcpExecutionEvidenceRequest): Promise<GcpExecutionEvidenceObservation> {
    if (
      request.need_sha256 !== canonicalDigest(request.need) ||
      request.recipe_sha256 !== canonicalDigest(request.recipe) ||
      request.recipe.need_sha256 !== request.need_sha256 ||
      canonicalDigest(request.recipe.need) !== request.need_sha256
    ) {
      throw new Error('GCP_EXECUTION_EVIDENCE_REQUEST_MISMATCH');
    }
    const expectedRecipe = deriveAssuranceEvidenceRecipe(this.repo, request.need);
    if (
      canonicalDigest(expectedRecipe) !== request.recipe_sha256 ||
      canonicalDigest(expectedRecipe) !== canonicalDigest(request.recipe)
    ) {
      throw new Error('GCP_EXECUTION_EVIDENCE_RECIPE_MISMATCH');
    }
    const context = runnerContext(this.env);
    const execution = observeAssuranceEvidenceRecipe(this.repo, expectedRecipe, this.runScript);
    return {
      provider: 'gcp',
      ...context,
      execution,
    };
  }
}

export function adaptGcpExecutionEvidence(
  request: GcpExecutionEvidenceRequest,
  value: unknown,
): GcpExecutionEvidenceRealization {
  if (!isData(value) || value.provider !== 'gcp') {
    return evidenceFailure('incomplete-observation', 'GCP_EXECUTION_EVIDENCE_OBSERVATION_INVALID');
  }

  let execution: AssuranceEvidenceExecutionObservation;
  let runnerName: string;
  let jobId: string;
  let targetRepository: string;
  try {
    execution = parseExecutionObservation(value.execution);
    runnerName = requiredString(value.runner_name, 'GCP_EXECUTION_EVIDENCE_RUNNER_INVALID');
    jobId = requiredString(value.job_id, 'GCP_EXECUTION_EVIDENCE_RUNNER_INVALID');
    targetRepository = requiredString(
      value.target_repository,
      'GCP_EXECUTION_EVIDENCE_RUNNER_INVALID',
    );
  } catch (error: unknown) {
    return evidenceFailure(
      'incomplete-observation',
      error instanceof Error ? error.message : String(error),
    );
  }

  if (
    execution.revision !== request.need.identity.revision ||
    execution.need_sha256 !== request.need_sha256
  ) {
    return evidenceFailure('stale-input', 'GCP_EXECUTION_EVIDENCE_STALE_INPUT');
  }
  if (
    execution.need_id !== request.need.need_id ||
    execution.recipe_sha256 !== request.recipe_sha256
  ) {
    return evidenceFailure('identity-mismatch', 'GCP_EXECUTION_EVIDENCE_IDENTITY_MISMATCH');
  }

  let receipt: ExecutionEvidenceReceipt;
  try {
    receipt = executionEvidenceReceiptFromRecipeObservation(request.recipe, execution);
  } catch (error: unknown) {
    return evidenceFailure(
      'incomplete-observation',
      error instanceof Error ? error.message : String(error),
    );
  }

  return {
    state: 'observed',
    receipt,
    provenance: {
      provider: 'gcp',
      runner_name: runnerName,
      job_id: jobId,
      target_repository: targetRepository,
      need_sha256: request.need_sha256,
      recipe_sha256: request.recipe_sha256,
    },
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2048 ? message : message.slice(0, 2048);
}

export async function realizeExecutionEvidenceOnGcp(
  need: AssuranceEvidenceNeed,
  executor: GcpExecutionEvidenceExecutor = new GcpRunnerExecutionEvidenceExecutor(),
  repo = process.cwd(),
): Promise<GcpExecutionEvidenceRealization> {
  let request: GcpExecutionEvidenceRequest;
  try {
    request = gcpExecutionEvidenceRequest(need, repo);
  } catch (error: unknown) {
    return evidenceFailure('identity-mismatch', errorMessage(error));
  }

  let observation: unknown;
  try {
    observation = await executor.execute(structuredClone(request));
  } catch (error: unknown) {
    return evidenceFailure(
      'transport-failure',
      `GCP_EXECUTION_EVIDENCE_TRANSPORT_FAILURE:${errorMessage(error)}`,
    );
  }
  return adaptGcpExecutionEvidence(request, observation);
}
