import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadArchitectureDatabase } from '../architecture/sql-model.ts';
import { canonicalDigest, canonicalJson } from '../digest.ts';
import {
  ASSURANCE_EVIDENCE_NEED_SCHEMA,
  type AssuranceEvidenceNeed,
  type AssuranceEvidenceNeedInputs,
} from '../source/assurance-evidence-needs.ts';
import { assertExactKeys, assertNonEmptyString, isData, isSha256Hex } from '../validation.ts';
import { executionEvidenceDescriptorForAssuranceNeed } from './assurance-evidence-descriptor.ts';
import {
  executionEvidenceReceipt,
  type ExecutionEvidenceRealization,
  type ExecutionEvidenceReceipt,
} from './evidence-receipt.ts';

export const ASSURANCE_EVIDENCE_RECIPE_SCHEMA = 'overcenter-assurance-evidence-recipe/v1' as const;
export const ASSURANCE_EVIDENCE_EXECUTION_OBSERVATION_SCHEMA =
  'overcenter-assurance-evidence-execution-observation/v1' as const;

const REQUIRED_NEED_INPUT_KEYS = [
  'coordinate',
  'model_sha256',
  'dependency_sha256',
  'proposition_ids',
  'obligation_ids',
  'artifact_ids',
  'package_scripts',
  'uses_package_runtime',
] as const;
const OPTIONAL_NEED_INPUT_KEYS = ['baseline_sha256'] as const;

export interface AssuranceEvidenceRecipe {
  schema: typeof ASSURANCE_EVIDENCE_RECIPE_SCHEMA;
  need: AssuranceEvidenceNeed;
  need_sha256: string;
  scripts: string[];
}

export interface AssuranceEvidenceExecutionAttempt {
  script: string;
  exit_code: number;
}

export interface AssuranceEvidenceExecutionObservation {
  schema: typeof ASSURANCE_EVIDENCE_EXECUTION_OBSERVATION_SCHEMA;
  need_id: string;
  need_sha256: string;
  revision: string;
  recipe_sha256: string;
  attempts: AssuranceEvidenceExecutionAttempt[];
}

export type AssuranceEvidenceScriptRunner = (script: string, cwd: string) => number;

function requiredNeedInput(
  inputs: AssuranceEvidenceNeedInputs,
  key: string,
  error = `ASSURANCE_EVIDENCE_INPUT_INVALID:${key}`,
): string {
  const member = inputs[key];
  assertNonEmptyString(member, error);
  return member;
}

function canonicalStringArray(value: string, error: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(error);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((member) => typeof member !== 'string' || member.length === 0)
  ) {
    throw new Error(error);
  }
  const canonical = [...new Set(parsed as string[])].sort();
  if (canonical.length !== parsed.length || canonicalJson(canonical) !== value) {
    throw new Error(error);
  }
  return canonical;
}

export function normalizeAssuranceEvidenceNeed(value: unknown): AssuranceEvidenceNeed {
  if (!isData(value)) throw new Error('ASSURANCE_EVIDENCE_NEED_INVALID');
  assertExactKeys(
    value,
    ['schema', 'need_id', 'identity', 'inputs'],
    [],
    'ASSURANCE_EVIDENCE_NEED_INVALID',
  );
  if (value.schema !== ASSURANCE_EVIDENCE_NEED_SCHEMA) {
    throw new Error('ASSURANCE_EVIDENCE_NEED_SCHEMA_INVALID');
  }
  assertNonEmptyString(value.need_id, 'ASSURANCE_EVIDENCE_NEED_ID_INVALID');

  if (!isData(value.identity)) throw new Error('ASSURANCE_EVIDENCE_NEED_IDENTITY_INVALID');
  assertExactKeys(
    value.identity,
    ['evidence_id', 'revision'],
    [],
    'ASSURANCE_EVIDENCE_NEED_IDENTITY_INVALID',
  );
  assertNonEmptyString(value.identity.evidence_id, 'ASSURANCE_EVIDENCE_ID_INVALID');
  assertNonEmptyString(value.identity.revision, 'ASSURANCE_EVIDENCE_REVISION_INVALID');
  if (!/^[0-9a-f]{40}$/.test(value.identity.revision)) {
    throw new Error('ASSURANCE_EVIDENCE_REVISION_INVALID');
  }

  if (!isData(value.inputs)) throw new Error('ASSURANCE_EVIDENCE_INPUTS_INVALID');
  const inputValue = value.inputs;
  assertExactKeys(
    inputValue,
    REQUIRED_NEED_INPUT_KEYS,
    OPTIONAL_NEED_INPUT_KEYS,
    'ASSURANCE_EVIDENCE_INPUTS_INVALID',
  );
  const inputs = Object.fromEntries(
    [...REQUIRED_NEED_INPUT_KEYS, ...OPTIONAL_NEED_INPUT_KEYS]
      .filter((key) => Object.hasOwn(inputValue, key))
      .map((key) => {
        const member = inputValue[key];
        assertNonEmptyString(member, `ASSURANCE_EVIDENCE_INPUT_INVALID:${key}`);
        return [key, member];
      }),
  ) as AssuranceEvidenceNeedInputs;

  if (inputs.coordinate !== `revision:${value.identity.revision}`) {
    throw new Error('ASSURANCE_EVIDENCE_COORDINATE_MISMATCH');
  }
  if (!isSha256Hex(inputs.model_sha256) || !isSha256Hex(inputs.dependency_sha256)) {
    throw new Error('ASSURANCE_EVIDENCE_DIGEST_INVALID');
  }
  if (inputs.baseline_sha256 !== undefined && !isSha256Hex(inputs.baseline_sha256)) {
    throw new Error('ASSURANCE_EVIDENCE_BASELINE_DIGEST_INVALID');
  }
  if (inputs.uses_package_runtime !== 'true' && inputs.uses_package_runtime !== 'false') {
    throw new Error('ASSURANCE_EVIDENCE_PACKAGE_RUNTIME_INVALID');
  }
  for (const key of [
    'proposition_ids',
    'obligation_ids',
    'artifact_ids',
    'package_scripts',
  ] as const) {
    canonicalStringArray(requiredNeedInput(inputs, key), `ASSURANCE_EVIDENCE_INPUT_INVALID:${key}`);
  }

  const identity = {
    evidence_id: value.identity.evidence_id,
    revision: value.identity.revision,
  };
  const expectedNeedId = `assurance-evidence:${canonicalDigest({
    schema: ASSURANCE_EVIDENCE_NEED_SCHEMA,
    identity,
    inputs,
  })}`;
  if (value.need_id !== expectedNeedId) throw new Error('ASSURANCE_EVIDENCE_NEED_ID_MISMATCH');

  return {
    schema: ASSURANCE_EVIDENCE_NEED_SCHEMA,
    need_id: value.need_id,
    identity,
    inputs,
  };
}

function assertRecipe(recipe: AssuranceEvidenceRecipe): AssuranceEvidenceNeed {
  if (recipe.schema !== ASSURANCE_EVIDENCE_RECIPE_SCHEMA) {
    throw new Error('ASSURANCE_EVIDENCE_RECIPE_SCHEMA_INVALID');
  }
  const need = normalizeAssuranceEvidenceNeed(recipe.need);
  if (recipe.need_sha256 !== canonicalDigest(need)) {
    throw new Error('ASSURANCE_EVIDENCE_RECIPE_NEED_MISMATCH');
  }
  const canonicalScripts = [...new Set(recipe.scripts)].sort();
  if (
    canonicalScripts.length === 0 ||
    canonicalScripts.length !== recipe.scripts.length ||
    recipe.scripts.some((script, index) => {
      assertNonEmptyString(script, 'ASSURANCE_EVIDENCE_RECIPE_SCRIPT_INVALID');
      return script !== canonicalScripts[index];
    })
  ) {
    throw new Error('ASSURANCE_EVIDENCE_RECIPE_SCRIPTS_NONCANONICAL');
  }
  if (canonicalJson(recipe.scripts) !== requiredNeedInput(need.inputs, 'package_scripts')) {
    throw new Error('ASSURANCE_EVIDENCE_RECIPE_NEED_SCRIPTS_MISMATCH');
  }
  if (requiredNeedInput(need.inputs, 'uses_package_runtime') !== 'true') {
    throw new Error('ASSURANCE_EVIDENCE_RECIPE_RUNTIME_UNAVAILABLE');
  }
  return need;
}

export function deriveAssuranceEvidenceRecipe(
  repo: string,
  needValue: AssuranceEvidenceNeed,
): AssuranceEvidenceRecipe {
  const need = normalizeAssuranceEvidenceNeed(needValue);
  const requestedScripts = canonicalStringArray(
    requiredNeedInput(need.inputs, 'package_scripts', 'ASSURANCE_EVIDENCE_PACKAGE_SCRIPTS_INVALID'),
    'ASSURANCE_EVIDENCE_PACKAGE_SCRIPTS_INVALID',
  );
  if (
    requiredNeedInput(need.inputs, 'uses_package_runtime') !== 'true' ||
    requestedScripts.length === 0
  ) {
    throw new Error(`ASSURANCE_EVIDENCE_REALIZATION_UNAVAILABLE:${need.identity.evidence_id}`);
  }

  const root = resolve(repo);
  if (need.identity.evidence_id.startsWith('baseline:')) {
    if (canonicalJson(requestedScripts) !== canonicalJson(['verify:repository'])) {
      throw new Error('ASSURANCE_EVIDENCE_BASELINE_RECIPE_MISMATCH');
    }
  } else {
    const db = loadArchitectureDatabase(root);
    let modeledScripts: string[];
    try {
      modeledScripts = (
        db
          .prepare(
            'SELECT script_name FROM evidence_uses_package_script WHERE evidence_id = ? ORDER BY script_name',
          )
          .all(need.identity.evidence_id) as unknown as Array<{ script_name: string }>
      ).map((row) => row.script_name);
    } finally {
      db.close();
    }
    if (canonicalJson(modeledScripts) !== canonicalJson(requestedScripts)) {
      throw new Error('ASSURANCE_EVIDENCE_RECIPE_MODEL_MISMATCH');
    }
  }

  const packageValue: unknown = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (!isData(packageValue) || !isData(packageValue.scripts)) {
    throw new Error('ASSURANCE_EVIDENCE_PACKAGE_INVALID');
  }
  for (const script of requestedScripts) {
    if (typeof packageValue.scripts[script] !== 'string') {
      throw new Error(`ASSURANCE_EVIDENCE_SCRIPT_UNAVAILABLE:${script}`);
    }
  }

  const recipe: AssuranceEvidenceRecipe = {
    schema: ASSURANCE_EVIDENCE_RECIPE_SCHEMA,
    need,
    need_sha256: canonicalDigest(need),
    scripts: requestedScripts,
  };
  assertRecipe(recipe);
  return recipe;
}

export function assuranceEvidenceDescriptorForRecipe(recipe: AssuranceEvidenceRecipe) {
  return executionEvidenceDescriptorForAssuranceNeed(assertRecipe(recipe));
}

function defaultRunScript(script: string, cwd: string): number {
  const result = spawnSync('npm', ['run', '--silent', script], {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`ASSURANCE_EVIDENCE_SCRIPT_SIGNAL:${script}:${result.signal}`);
  if (result.status === null) throw new Error(`ASSURANCE_EVIDENCE_SCRIPT_STATUS_MISSING:${script}`);
  return result.status;
}

export function observeAssuranceEvidenceRecipe(
  repo: string,
  recipe: AssuranceEvidenceRecipe,
  runScript: AssuranceEvidenceScriptRunner = defaultRunScript,
): AssuranceEvidenceExecutionObservation {
  const need = assertRecipe(recipe);
  const root = resolve(repo);
  const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  if (revision !== need.identity.revision) {
    throw new Error('ASSURANCE_EVIDENCE_CHECKOUT_REVISION_MISMATCH');
  }

  const attempts: AssuranceEvidenceExecutionAttempt[] = [];
  for (const script of recipe.scripts) {
    const exitCode = runScript(script, root);
    if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
      throw new Error(`ASSURANCE_EVIDENCE_SCRIPT_EXIT_INVALID:${script}`);
    }
    attempts.push({ script, exit_code: exitCode });
    if (exitCode !== 0) break;
  }

  return {
    schema: ASSURANCE_EVIDENCE_EXECUTION_OBSERVATION_SCHEMA,
    need_id: need.need_id,
    need_sha256: recipe.need_sha256,
    revision: need.identity.revision,
    recipe_sha256: canonicalDigest(recipe),
    attempts,
  };
}

function executionResult(
  recipe: AssuranceEvidenceRecipe,
  observation: AssuranceEvidenceExecutionObservation,
): 'satisfied' | 'unsatisfied' {
  const need = assertRecipe(recipe);
  if (
    observation.schema !== ASSURANCE_EVIDENCE_EXECUTION_OBSERVATION_SCHEMA ||
    observation.need_id !== need.need_id ||
    observation.need_sha256 !== recipe.need_sha256 ||
    observation.revision !== need.identity.revision ||
    observation.recipe_sha256 !== canonicalDigest(recipe)
  ) {
    throw new Error('ASSURANCE_EVIDENCE_EXECUTION_IDENTITY_MISMATCH');
  }
  if (observation.attempts.length === 0 || observation.attempts.length > recipe.scripts.length) {
    throw new Error('ASSURANCE_EVIDENCE_EXECUTION_INCOMPLETE');
  }

  let failed = false;
  for (let index = 0; index < observation.attempts.length; index += 1) {
    const attempt = observation.attempts[index]!;
    if (
      attempt.script !== recipe.scripts[index] ||
      !Number.isSafeInteger(attempt.exit_code) ||
      attempt.exit_code < 0 ||
      attempt.exit_code > 255
    ) {
      throw new Error('ASSURANCE_EVIDENCE_EXECUTION_ATTEMPT_INVALID');
    }
    if (attempt.exit_code !== 0) {
      if (index !== observation.attempts.length - 1) {
        throw new Error('ASSURANCE_EVIDENCE_EXECUTION_AFTER_FAILURE');
      }
      failed = true;
    }
  }
  if (!failed && observation.attempts.length !== recipe.scripts.length) {
    throw new Error('ASSURANCE_EVIDENCE_EXECUTION_INCOMPLETE');
  }
  return failed ? 'unsatisfied' : 'satisfied';
}

export function executionEvidenceRealizationFromRecipeObservation(
  recipe: AssuranceEvidenceRecipe,
  observation: AssuranceEvidenceExecutionObservation,
): ExecutionEvidenceRealization {
  const descriptor = assuranceEvidenceDescriptorForRecipe(recipe);
  return {
    ...descriptor,
    outputs: {
      realization_recipe_sha256: canonicalDigest(recipe),
      package_scripts_sha256: canonicalDigest(recipe.scripts),
    },
    semantic_evidence: {
      realization_kind: 'package-scripts/v1',
    },
    observation: { result: executionResult(recipe, observation) },
  };
}

export function executionEvidenceReceiptFromRecipeObservation(
  recipe: AssuranceEvidenceRecipe,
  observation: AssuranceEvidenceExecutionObservation,
): ExecutionEvidenceReceipt {
  const descriptor = assuranceEvidenceDescriptorForRecipe(recipe);
  return executionEvidenceReceipt(
    descriptor,
    executionEvidenceRealizationFromRecipeObservation(recipe, observation),
  );
}
