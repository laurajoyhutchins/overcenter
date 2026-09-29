import { readFileSync } from 'node:fs';

export const SEMANTIC_SCALING_SCHEMA = 'overcenter-semantic-scaling/v1' as const;

export type SemanticScalingRung =
  | 'pure-computation'
  | 'mechanical-source-transformation'
  | 'behavioral-bug-repair'
  | 'behavior-preserving-migration'
  | 'architectural-design-requirement'
  | 'consequential-external-effect';

export type SemanticScalingClassification =
  | 'convergent'
  | 'frontier-limited'
  | 'semantic-mirroring'
  | 'unsupported';

export interface TrustedSemanticSurface {
  id: string;
  authority_bearing: boolean;
  scope: 'reused-general' | 'new-reusable' | 'task-specific' | 'provider-specific';
  semantic_relation: 'general-proof-primitive' | 'domain-observation' | 'candidate-equivalent';
}

export interface SemanticScalingTask {
  task_id: string;
  rung: SemanticScalingRung;
  work_identity: string;
  authoritative_claim: {
    kind: 'direct-postcondition' | 'attested-judgment' | 'none';
    statement: string;
    narrowed_from?: string;
  };
  mechanically_settleable: boolean;
  verifier_reconstructs_candidate_reasoning: boolean;
  residual_judgment?: string;
  trusted_surfaces: TrustedSemanticSurface[];
  external_assumptions: string[];
  observation_support: string[];
  proof_obligations: string[];
  judgment_route:
    | 'deterministic-software-action'
    | 'reasoning-required'
    | 'recovery-required'
    | 'unsupported';
  expected_classification: SemanticScalingClassification;
}

export interface SemanticScalingFixture {
  schema: typeof SEMANTIC_SCALING_SCHEMA;
  tasks: SemanticScalingTask[];
}

export interface SemanticScalingResult {
  task_id: string;
  rung: SemanticScalingRung;
  classification: SemanticScalingClassification;
  reused_authority_surfaces: string[];
  new_reusable_authority_surfaces: string[];
  task_specific_authority_surfaces: string[];
  provider_specific_authority_surfaces: string[];
  residual_judgment: string | null;
  narrowed_claim: boolean;
  verifier_reconstructs_candidate_reasoning: boolean;
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`SEMANTIC_SCALING_INVALID_STRING:${field}`);
  }
}

function validateSurface(value: unknown, taskId: string): asserts value is TrustedSemanticSurface {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`SEMANTIC_SCALING_INVALID_SURFACE:${taskId}`);
  }
  const surface = value as Record<string, unknown>;
  requireString(surface.id, `${taskId}.trusted_surfaces.id`);
  if (typeof surface.authority_bearing !== 'boolean') {
    throw new Error(`SEMANTIC_SCALING_INVALID_AUTHORITY_FLAG:${taskId}:${surface.id}`);
  }
  if (
    !['reused-general', 'new-reusable', 'task-specific', 'provider-specific'].includes(
      String(surface.scope),
    )
  ) {
    throw new Error(`SEMANTIC_SCALING_INVALID_SCOPE:${taskId}:${surface.id}`);
  }
  if (
    !['general-proof-primitive', 'domain-observation', 'candidate-equivalent'].includes(
      String(surface.semantic_relation),
    )
  ) {
    throw new Error(`SEMANTIC_SCALING_INVALID_RELATION:${taskId}:${surface.id}`);
  }
}

export function validateSemanticScalingFixture(value: unknown): SemanticScalingFixture {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('SEMANTIC_SCALING_INVALID_FIXTURE');
  }
  const fixture = value as Record<string, unknown>;
  if (fixture.schema !== SEMANTIC_SCALING_SCHEMA || !Array.isArray(fixture.tasks)) {
    throw new Error('SEMANTIC_SCALING_SCHEMA_UNSUPPORTED');
  }

  const rungs: readonly SemanticScalingRung[] = [
    'pure-computation',
    'mechanical-source-transformation',
    'behavioral-bug-repair',
    'behavior-preserving-migration',
    'architectural-design-requirement',
    'consequential-external-effect',
  ];
  const claimKinds: readonly SemanticScalingTask['authoritative_claim']['kind'][] = [
    'direct-postcondition',
    'attested-judgment',
    'none',
  ];
  const judgmentRoutes: readonly SemanticScalingTask['judgment_route'][] = [
    'deterministic-software-action',
    'reasoning-required',
    'recovery-required',
    'unsupported',
  ];
  const classifications: readonly SemanticScalingClassification[] = [
    'convergent',
    'frontier-limited',
    'semantic-mirroring',
    'unsupported',
  ];

  const seen = new Set<string>();
  for (const valueTask of fixture.tasks) {
    if (typeof valueTask !== 'object' || valueTask === null || Array.isArray(valueTask)) {
      throw new Error('SEMANTIC_SCALING_INVALID_TASK');
    }
    const task = valueTask as unknown as SemanticScalingTask;
    requireString(task.task_id, 'task_id');
    if (seen.has(task.task_id)) throw new Error(`SEMANTIC_SCALING_DUPLICATE_TASK:${task.task_id}`);
    seen.add(task.task_id);
    requireString(task.work_identity, `${task.task_id}.work_identity`);

    if (!rungs.includes(task.rung)) {
      throw new Error(`SEMANTIC_SCALING_INVALID_RUNG:${task.task_id}`);
    }
    if (
      typeof task.authoritative_claim !== 'object' ||
      task.authoritative_claim === null ||
      !claimKinds.includes(task.authoritative_claim.kind)
    ) {
      throw new Error(`SEMANTIC_SCALING_INVALID_CLAIM:${task.task_id}`);
    }
    requireString(
      task.authoritative_claim.statement,
      `${task.task_id}.authoritative_claim.statement`,
    );
    if (
      task.authoritative_claim.narrowed_from !== undefined &&
      (typeof task.authoritative_claim.narrowed_from !== 'string' ||
        task.authoritative_claim.narrowed_from.length === 0)
    ) {
      throw new Error(`SEMANTIC_SCALING_INVALID_NARROWED_CLAIM:${task.task_id}`);
    }
    if (
      task.residual_judgment !== undefined &&
      (typeof task.residual_judgment !== 'string' || task.residual_judgment.length === 0)
    ) {
      throw new Error(`SEMANTIC_SCALING_INVALID_RESIDUAL_JUDGMENT:${task.task_id}`);
    }
    if (
      typeof task.mechanically_settleable !== 'boolean' ||
      typeof task.verifier_reconstructs_candidate_reasoning !== 'boolean'
    ) {
      throw new Error(`SEMANTIC_SCALING_INVALID_SETTLEMENT_FLAGS:${task.task_id}`);
    }
    if (!judgmentRoutes.includes(task.judgment_route)) {
      throw new Error(`SEMANTIC_SCALING_INVALID_JUDGMENT_ROUTE:${task.task_id}`);
    }
    if (!classifications.includes(task.expected_classification)) {
      throw new Error(`SEMANTIC_SCALING_INVALID_EXPECTED_CLASSIFICATION:${task.task_id}`);
    }
    if (!Array.isArray(task.trusted_surfaces)) {
      throw new Error(`SEMANTIC_SCALING_INVALID_SURFACES:${task.task_id}`);
    }
    for (const surface of task.trusted_surfaces) validateSurface(surface, task.task_id);
    for (const field of [
      'external_assumptions',
      'observation_support',
      'proof_obligations',
    ] as const) {
      if (!Array.isArray(task[field]) || task[field].some((entry) => typeof entry !== 'string')) {
        throw new Error(`SEMANTIC_SCALING_INVALID_LIST:${task.task_id}.${field}`);
      }
    }
  }

  return value as SemanticScalingFixture;
}

export function classifySemanticScaling(task: SemanticScalingTask): SemanticScalingClassification {
  if (!task.mechanically_settleable || task.authoritative_claim.kind === 'none') {
    return 'unsupported';
  }

  const mirrorsCandidate =
    task.verifier_reconstructs_candidate_reasoning ||
    task.trusted_surfaces.some(
      (surface) =>
        surface.authority_bearing &&
        surface.scope === 'task-specific' &&
        surface.semantic_relation === 'candidate-equivalent',
    );

  if (mirrorsCandidate) return 'semantic-mirroring';

  if (
    task.authoritative_claim.narrowed_from !== undefined ||
    task.residual_judgment !== undefined
  ) {
    return 'frontier-limited';
  }

  return 'convergent';
}

function authoritySurfaceIds(
  task: SemanticScalingTask,
  scope: TrustedSemanticSurface['scope'],
): string[] {
  return task.trusted_surfaces
    .filter((surface) => surface.authority_bearing && surface.scope === scope)
    .map((surface) => surface.id)
    .sort();
}

export function evaluateSemanticScalingTask(task: SemanticScalingTask): SemanticScalingResult {
  return {
    task_id: task.task_id,
    rung: task.rung,
    classification: classifySemanticScaling(task),
    reused_authority_surfaces: authoritySurfaceIds(task, 'reused-general'),
    new_reusable_authority_surfaces: authoritySurfaceIds(task, 'new-reusable'),
    task_specific_authority_surfaces: authoritySurfaceIds(task, 'task-specific'),
    provider_specific_authority_surfaces: authoritySurfaceIds(task, 'provider-specific'),
    residual_judgment: task.residual_judgment ?? null,
    narrowed_claim: task.authoritative_claim.narrowed_from !== undefined,
    verifier_reconstructs_candidate_reasoning: task.verifier_reconstructs_candidate_reasoning,
  };
}

export function evaluateSemanticScalingFixture(
  fixture: SemanticScalingFixture,
): SemanticScalingResult[] {
  return [...fixture.tasks]
    .sort((left, right) => left.task_id.localeCompare(right.task_id))
    .map(evaluateSemanticScalingTask);
}

function main(): void {
  const fixturePath = process.argv[2] ?? 'experiments/semantic-scaling/fixtures.json';
  const fixture = validateSemanticScalingFixture(JSON.parse(readFileSync(fixturePath, 'utf8')));
  const results = evaluateSemanticScalingFixture(fixture);

  const mismatches = fixture.tasks
    .map((task) => ({
      task_id: task.task_id,
      expected: task.expected_classification,
      actual: classifySemanticScaling(task),
    }))
    .filter((result) => result.expected !== result.actual);

  process.stdout.write(
    `${JSON.stringify(
      {
        schema: 'overcenter-semantic-scaling-result/v1',
        tasks: results,
      },
      null,
      2,
    )}\n`,
  );

  if (mismatches.length > 0) {
    throw new Error(`SEMANTIC_SCALING_CLASSIFICATION_MISMATCH:${JSON.stringify(mismatches)}`);
  }
}

if (process.argv[1]?.endsWith('experiment.ts')) main();
