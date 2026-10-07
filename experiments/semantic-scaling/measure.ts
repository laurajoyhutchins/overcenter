import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const SEMANTIC_SCALING_MEASUREMENT_PLAN_SCHEMA =
  'overcenter-semantic-scaling-measurement-plan/v1' as const;
export const SEMANTIC_SCALING_MEASUREMENT_RESULT_SCHEMA =
  'overcenter-semantic-scaling-measurement-result/v1' as const;

export type SemanticScalingScopeKind = 'property' | 'architecture-effect';
export type SemanticScalingScopeRole =
  | 'reused-general'
  | 'new-reusable'
  | 'task-specific'
  | 'provider-specific';

export interface SemanticScalingMeasurementScope {
  kind: SemanticScalingScopeKind;
  id: string;
  role: SemanticScalingScopeRole;
}

export interface SemanticScalingMeasurementTask {
  task_id: string;
  rung:
    | 'pure-computation'
    | 'mechanical-source-transformation'
    | 'behavioral-bug-repair'
    | 'behavior-preserving-migration'
    | 'architectural-design-requirement'
    | 'consequential-external-effect';
  classification: 'convergent' | 'frontier-limited' | 'semantic-mirroring' | 'unsupported';
  claim: string;
  narrowed_from?: string;
  residual_judgment?: string;
  scopes: SemanticScalingMeasurementScope[];
  evidence: string[];
  observation_support: string[];
}

export interface SemanticScalingMeasurementPlan {
  schema: typeof SEMANTIC_SCALING_MEASUREMENT_PLAN_SCHEMA;
  tasks: SemanticScalingMeasurementTask[];
}

interface SymbolDeclaration {
  path: string;
  symbol: string;
  start_line: number;
  end_line: number;
}

interface SemanticSpan {
  path: string;
  start_offset: number;
  end_offset: number;
  semantic_loc: number;
}

interface HybridScopeReport {
  hybrid_closure_semantic_loc: number;
  hybrid_closure_sha256: string;
  hybrid_closure_files: string[];
  module_closure_files?: string[];
  symbol_closure_declarations?: SymbolDeclaration[];
  hybrid_closure_semantic_spans?: SemanticSpan[];
  hybrid_closure_semantic_line_ranges?: Array<{
    path: string;
    ranges: Array<[number, number]>;
  }>;
  external_assumptions?: string[];
  scope_sha256?: string;
}

interface TcbPropertyReport extends HybridScopeReport {
  id: string;
}

interface ArchitectureEffectReport extends HybridScopeReport {
  effect_id: string;
}

export interface SemanticScalingTcbReport {
  schema: 'overcenter-tcb-report';
  schema_version: 1;
  semantic_loc_basis?: 'typescript-logical-sloc/v1';
  properties: TcbPropertyReport[];
  architecture_tcb: {
    effects: ArchitectureEffectReport[];
  };
  reconciliation?: {
    admitted: boolean;
    baseline_revision: string;
  } | null;
}

interface ResolvedScope {
  key: string;
  role: SemanticScalingScopeRole;
  report: HybridScopeReport;
  spans: SemanticSpan[];
}

interface SemanticSpanContribution extends SemanticSpan {
  marginal_semantic_loc: number;
  covered_prior_spans: string[];
}

export interface SemanticScalingMeasurementResult {
  schema: typeof SEMANTIC_SCALING_MEASUREMENT_RESULT_SCHEMA;
  source_revision: string;
  tcb_report_sha256: string;
  plan_sha256: string;
  tasks: Array<{
    task_id: string;
    rung: SemanticScalingMeasurementTask['rung'];
    classification: SemanticScalingMeasurementTask['classification'];
    claim: string;
    narrowed_from: string | null;
    residual_judgment: string | null;
    trusted_semantic_loc: number;
    marginal_semantic_loc: number;
    reused_prior_semantic_loc: number;
    marginal_unit_sha256: string;
    marginal_files: string[];
    introduced_scopes: Array<{
      key: string;
      role: SemanticScalingScopeRole;
      hybrid_closure_semantic_loc: number;
      hybrid_closure_sha256: string;
      scope_sha256: string | null;
    }>;
    introduced_external_assumptions: string[];
    task_specific_marginal_semantic_loc: number;
    provider_specific_marginal_semantic_loc: number;
    new_reusable_marginal_semantic_loc: number;
    evidence: string[];
    observation_support: string[];
  }>;
}

function semanticLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith('//') &&
    !trimmed.startsWith('/*') &&
    !trimmed.startsWith('*') &&
    !trimmed.startsWith('*/')
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function optionValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`SEMANTIC_SCALING_OPTION_VALUE_REQUIRED:${name}`);
  }
  return value;
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`SEMANTIC_SCALING_MEASUREMENT_INVALID_STRING:${field}`);
  }
}

function requireStringList(value: unknown, field: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new Error(`SEMANTIC_SCALING_MEASUREMENT_INVALID_LIST:${field}`);
  }
}

export function validateSemanticScalingMeasurementPlan(
  value: unknown,
): SemanticScalingMeasurementPlan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('SEMANTIC_SCALING_MEASUREMENT_PLAN_INVALID');
  }
  const plan = value as Record<string, unknown>;
  if (
    plan.schema !== SEMANTIC_SCALING_MEASUREMENT_PLAN_SCHEMA ||
    !Array.isArray(plan.tasks) ||
    plan.tasks.length === 0
  ) {
    throw new Error('SEMANTIC_SCALING_MEASUREMENT_PLAN_SCHEMA_UNSUPPORTED');
  }

  const rungs = new Set<SemanticScalingMeasurementTask['rung']>([
    'pure-computation',
    'mechanical-source-transformation',
    'behavioral-bug-repair',
    'behavior-preserving-migration',
    'architectural-design-requirement',
    'consequential-external-effect',
  ]);
  const classifications = new Set<SemanticScalingMeasurementTask['classification']>([
    'convergent',
    'frontier-limited',
    'semantic-mirroring',
    'unsupported',
  ]);
  const kinds = new Set<SemanticScalingScopeKind>(['property', 'architecture-effect']);
  const roles = new Set<SemanticScalingScopeRole>([
    'reused-general',
    'new-reusable',
    'task-specific',
    'provider-specific',
  ]);

  const seenTasks = new Set<string>();
  for (const rawTask of plan.tasks) {
    if (typeof rawTask !== 'object' || rawTask === null || Array.isArray(rawTask)) {
      throw new Error('SEMANTIC_SCALING_MEASUREMENT_TASK_INVALID');
    }
    const task = rawTask as unknown as SemanticScalingMeasurementTask;
    requireString(task.task_id, 'task_id');
    if (seenTasks.has(task.task_id)) {
      throw new Error(`SEMANTIC_SCALING_MEASUREMENT_DUPLICATE_TASK:${task.task_id}`);
    }
    seenTasks.add(task.task_id);
    if (!rungs.has(task.rung)) {
      throw new Error(`SEMANTIC_SCALING_MEASUREMENT_INVALID_RUNG:${task.task_id}`);
    }
    if (!classifications.has(task.classification)) {
      throw new Error(`SEMANTIC_SCALING_MEASUREMENT_INVALID_CLASSIFICATION:${task.task_id}`);
    }
    requireString(task.claim, `${task.task_id}.claim`);
    if (task.narrowed_from !== undefined) {
      requireString(task.narrowed_from, `${task.task_id}.narrowed_from`);
    }
    if (task.residual_judgment !== undefined) {
      requireString(task.residual_judgment, `${task.task_id}.residual_judgment`);
    }
    if (
      task.classification === 'frontier-limited' &&
      (task.narrowed_from === undefined || task.residual_judgment === undefined)
    ) {
      throw new Error(`SEMANTIC_SCALING_FRONTIER_EVIDENCE_REQUIRED:${task.task_id}`);
    }
    if (
      task.classification !== 'frontier-limited' &&
      (task.narrowed_from !== undefined || task.residual_judgment !== undefined)
    ) {
      throw new Error(`SEMANTIC_SCALING_FRONTIER_EVIDENCE_UNEXPECTED:${task.task_id}`);
    }
    if (!Array.isArray(task.scopes) || task.scopes.length === 0) {
      throw new Error(`SEMANTIC_SCALING_MEASUREMENT_SCOPES_REQUIRED:${task.task_id}`);
    }
    const seenScopes = new Set<string>();
    for (const scope of task.scopes) {
      if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
        throw new Error(`SEMANTIC_SCALING_MEASUREMENT_SCOPE_INVALID:${task.task_id}`);
      }
      requireString(scope.id, `${task.task_id}.scope.id`);
      if (!kinds.has(scope.kind) || !roles.has(scope.role)) {
        throw new Error(`SEMANTIC_SCALING_MEASUREMENT_SCOPE_VOCABULARY_INVALID:${task.task_id}`);
      }
      const key = `${scope.kind}:${scope.id}`;
      if (seenScopes.has(key)) {
        throw new Error(`SEMANTIC_SCALING_MEASUREMENT_DUPLICATE_SCOPE:${task.task_id}:${key}`);
      }
      seenScopes.add(key);
    }
    requireStringList(task.evidence, `${task.task_id}.evidence`);
    requireStringList(task.observation_support, `${task.task_id}.observation_support`);
  }

  return value as SemanticScalingMeasurementPlan;
}

function validateTcbReport(value: unknown): SemanticScalingTcbReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('SEMANTIC_SCALING_TCB_REPORT_INVALID');
  }
  const report = value as SemanticScalingTcbReport;
  if (
    report.schema !== 'overcenter-tcb-report' ||
    report.schema_version !== 1 ||
    !Array.isArray(report.properties) ||
    !Array.isArray(report.architecture_tcb?.effects)
  ) {
    throw new Error('SEMANTIC_SCALING_TCB_REPORT_SCHEMA_UNSUPPORTED');
  }
  if (
    report.semantic_loc_basis !== undefined &&
    report.semantic_loc_basis !== 'typescript-logical-sloc/v1'
  ) {
    throw new Error('SEMANTIC_SCALING_TCB_SEMANTIC_LOC_BASIS_UNSUPPORTED');
  }
  if (
    report.reconciliation !== undefined &&
    report.reconciliation !== null &&
    !report.reconciliation.admitted
  ) {
    throw new Error('SEMANTIC_SCALING_TCB_REPORT_NOT_ADMITTED');
  }
  return report;
}

function semanticSpanIdentity(span: SemanticSpan): string {
  return `${span.path}:${span.start_offset}-${span.end_offset}:${span.semantic_loc}`;
}

function normalizeSemanticSpans(spans: readonly SemanticSpan[]): SemanticSpan[] {
  const sorted = [...spans].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.start_offset - right.start_offset ||
      right.end_offset - left.end_offset,
  );
  const normalized: SemanticSpan[] = [];

  for (const span of sorted) {
    requireString(span.path, 'hybrid_closure_semantic_spans.path');
    if (
      !Number.isSafeInteger(span.start_offset) ||
      !Number.isSafeInteger(span.end_offset) ||
      !Number.isSafeInteger(span.semantic_loc) ||
      span.start_offset < 0 ||
      span.end_offset <= span.start_offset ||
      span.semantic_loc < 0
    ) {
      throw new Error(`SEMANTIC_SCALING_TCB_SPAN_INVALID:${span.path}`);
    }

    const previous = normalized.at(-1);
    if (!previous || previous.path !== span.path) {
      normalized.push({ ...span });
      continue;
    }

    if (
      previous.start_offset === span.start_offset &&
      previous.end_offset === span.end_offset
    ) {
      if (previous.semantic_loc !== span.semantic_loc) {
        throw new Error(`SEMANTIC_SCALING_TCB_SPAN_CONFLICT:${span.path}`);
      }
      continue;
    }

    if (
      previous.start_offset <= span.start_offset &&
      previous.end_offset >= span.end_offset
    ) {
      continue;
    }

    if (span.start_offset < previous.end_offset) {
      throw new Error(`SEMANTIC_SCALING_TCB_SPANS_OVERLAP:${span.path}`);
    }

    normalized.push({ ...span });
  }

  return normalized;
}

function semanticSpanLoc(spans: readonly SemanticSpan[]): number {
  return normalizeSemanticSpans(spans).reduce((sum, span) => sum + span.semantic_loc, 0);
}

function semanticSpanUnion(
  left: readonly SemanticSpan[],
  right: readonly SemanticSpan[],
): SemanticSpan[] {
  return normalizeSemanticSpans([...left, ...right]);
}

function semanticSpanDifference(
  current: readonly SemanticSpan[],
  prior: readonly SemanticSpan[],
): SemanticSpanContribution[] {
  const normalizedCurrent = normalizeSemanticSpans(current);
  const normalizedPrior = normalizeSemanticSpans(prior);
  const contributions: SemanticSpanContribution[] = [];

  for (const span of normalizedCurrent) {
    const relatedPrior = normalizedPrior.filter(
      (candidate) =>
        candidate.path === span.path &&
        candidate.start_offset < span.end_offset &&
        span.start_offset < candidate.end_offset,
    );

    const containing = relatedPrior.find(
      (candidate) =>
        candidate.start_offset <= span.start_offset &&
        candidate.end_offset >= span.end_offset,
    );
    if (containing) continue;

    const contained = relatedPrior.filter(
      (candidate) =>
        span.start_offset <= candidate.start_offset &&
        span.end_offset >= candidate.end_offset,
    );
    const partial = relatedPrior.filter(
      (candidate) =>
        !contained.includes(candidate) &&
        !(
          candidate.start_offset <= span.start_offset &&
          candidate.end_offset >= span.end_offset
        ),
    );
    if (partial.length > 0) {
      throw new Error(`SEMANTIC_SCALING_TCB_SPANS_OVERLAP:${span.path}`);
    }

    const coveredLoc = contained.reduce((sum, candidate) => sum + candidate.semantic_loc, 0);
    const marginalLoc = span.semantic_loc - coveredLoc;
    if (marginalLoc < 0) {
      throw new Error(`SEMANTIC_SCALING_TCB_SPAN_LOC_CONFLICT:${span.path}`);
    }
    if (marginalLoc === 0) continue;

    contributions.push({
      ...span,
      marginal_semantic_loc: marginalLoc,
      covered_prior_spans: contained.map(semanticSpanIdentity).sort(),
    });
  }

  return contributions;
}

function contributionSemanticLoc(contributions: readonly SemanticSpanContribution[]): number {
  return contributions.reduce((sum, contribution) => sum + contribution.marginal_semantic_loc, 0);
}

function digestSpanContributions(contributions: readonly SemanticSpanContribution[]): string {
  return sha256(
    [...contributions]
      .sort(
        (left, right) =>
          left.path.localeCompare(right.path) ||
          left.start_offset - right.start_offset ||
          left.end_offset - right.end_offset,
      )
      .map(
        (contribution) =>
          `${semanticSpanIdentity(contribution)}=>${contribution.marginal_semantic_loc}[${contribution.covered_prior_spans.join(',')}]`,
      )
      .join('\n'),
  );
}

function legacyUnitsAsSpans(units: Set<string>): SemanticSpan[] {
  return [...units].map((unit) => {
    const separator = unit.lastIndexOf(':');
    if (separator < 0) throw new Error(`SEMANTIC_SCALING_UNIT_INVALID:${unit}`);
    const path = unit.slice(0, separator);
    const line = Number(unit.slice(separator + 1));
    if (!Number.isSafeInteger(line) || line <= 0) {
      throw new Error(`SEMANTIC_SCALING_UNIT_INVALID:${unit}`);
    }
    return {
      path,
      start_offset: line * 2,
      end_offset: line * 2 + 1,
      semantic_loc: 1,
    };
  });
}

export function trustedUnitsForScope(
  scope: HybridScopeReport,
  readSource: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Set<string> {
  const trusted = new Set<string>();
  const reconstructedFiles = new Set<string>();

  if (scope.hybrid_closure_semantic_line_ranges !== undefined) {
    for (const entry of scope.hybrid_closure_semantic_line_ranges) {
      requireString(entry.path, 'hybrid_closure_semantic_line_ranges.path');
      if (reconstructedFiles.has(entry.path)) {
        throw new Error(`SEMANTIC_SCALING_TCB_RANGE_FILE_DUPLICATE:${entry.path}`);
      }
      reconstructedFiles.add(entry.path);
      const lines = readSource(entry.path).split('\n');
      let previousEnd = 0;
      for (const range of entry.ranges) {
        if (
          !Array.isArray(range) ||
          range.length !== 2 ||
          !Number.isSafeInteger(range[0]) ||
          !Number.isSafeInteger(range[1]) ||
          range[0] <= previousEnd ||
          range[1] < range[0]
        ) {
          throw new Error(`SEMANTIC_SCALING_TCB_RANGE_INVALID:${entry.path}`);
        }
        for (let line = range[0]; line <= range[1]; line += 1) {
          if (!semanticLine(lines[line - 1] ?? '')) {
            throw new Error(`SEMANTIC_SCALING_TCB_RANGE_NON_SEMANTIC:${entry.path}:${line}`);
          }
          trusted.add(`${entry.path}:${line}`);
        }
        previousEnd = range[1];
      }
    }
  } else {
    if (
      !Array.isArray(scope.module_closure_files) ||
      !Array.isArray(scope.symbol_closure_declarations)
    ) {
      throw new Error('SEMANTIC_SCALING_TCB_RECONSTRUCTION_EVIDENCE_MISSING');
    }
    const moduleFiles = new Set(scope.module_closure_files);

    for (const path of scope.module_closure_files) {
      reconstructedFiles.add(path);
      const lines = readSource(path).split('\n');
      lines.forEach((line, index) => {
        if (semanticLine(line)) trusted.add(`${path}:${index + 1}`);
      });
    }

    for (const declaration of scope.symbol_closure_declarations) {
      reconstructedFiles.add(declaration.path);
      if (moduleFiles.has(declaration.path)) continue;
      const lines = readSource(declaration.path).split('\n');
      for (let line = declaration.start_line; line <= declaration.end_line; line += 1) {
        if (semanticLine(lines[line - 1] ?? '')) trusted.add(`${declaration.path}:${line}`);
      }
    }
  }

  if (trusted.size !== scope.hybrid_closure_semantic_loc) {
    throw new Error(
      `SEMANTIC_SCALING_TCB_RECONSTRUCTION_MISMATCH:${trusted.size}:${scope.hybrid_closure_semantic_loc}`,
    );
  }

  const expectedFiles = new Set(scope.hybrid_closure_files);
  if (
    reconstructedFiles.size !== expectedFiles.size ||
    [...reconstructedFiles].some((path) => !expectedFiles.has(path))
  ) {
    throw new Error('SEMANTIC_SCALING_TCB_FILE_SET_MISMATCH');
  }

  return trusted;
}

function trustedSpansForScope(
  report: SemanticScalingTcbReport,
  scope: HybridScopeReport,
  readSource: (path: string) => string,
): SemanticSpan[] {
  if (report.semantic_loc_basis === 'typescript-logical-sloc/v1') {
    if (!Array.isArray(scope.hybrid_closure_semantic_spans)) {
      throw new Error('SEMANTIC_SCALING_TCB_SEMANTIC_SPANS_MISSING');
    }
    const spans = normalizeSemanticSpans(scope.hybrid_closure_semantic_spans);
    const semanticLoc = spans.reduce((sum, span) => sum + span.semantic_loc, 0);
    if (semanticLoc !== scope.hybrid_closure_semantic_loc) {
      throw new Error(
        `SEMANTIC_SCALING_TCB_RECONSTRUCTION_MISMATCH:${semanticLoc}:${scope.hybrid_closure_semantic_loc}`,
      );
    }
    const actualFiles = new Set(spans.map((span) => span.path));
    const expectedFiles = new Set(scope.hybrid_closure_files);
    if (
      actualFiles.size !== expectedFiles.size ||
      [...actualFiles].some((path) => !expectedFiles.has(path))
    ) {
      throw new Error('SEMANTIC_SCALING_TCB_FILE_SET_MISMATCH');
    }
    return spans;
  }

  return normalizeSemanticSpans(legacyUnitsAsSpans(trustedUnitsForScope(scope, readSource)));
}

function resolveScope(
  report: SemanticScalingTcbReport,
  requested: SemanticScalingMeasurementScope,
  readSource: (path: string) => string,
): ResolvedScope {
  if (requested.kind === 'property') {
    const property = report.properties.find((candidate) => candidate.id === requested.id);
    if (!property) {
      throw new Error(`SEMANTIC_SCALING_TCB_PROPERTY_UNKNOWN:${requested.id}`);
    }
    return {
      key: `property:${requested.id}`,
      role: requested.role,
      report: property,
      spans: trustedSpansForScope(report, property, readSource),
    };
  }

  const effect = report.architecture_tcb.effects.find(
    (candidate) => candidate.effect_id === requested.id,
  );
  if (!effect) {
    throw new Error(`SEMANTIC_SCALING_TCB_EFFECT_UNKNOWN:${requested.id}`);
  }
  return {
    key: `architecture-effect:${requested.id}`,
    role: requested.role,
    report: effect,
    spans: trustedSpansForScope(report, effect, readSource),
  };
}

export function measureSemanticScaling(
  plan: SemanticScalingMeasurementPlan,
  report: SemanticScalingTcbReport,
  sourceRevision: string,
  tcbReportSha256: string,
  planSha256: string,
  readSource: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): SemanticScalingMeasurementResult {
  requireString(sourceRevision, 'source_revision');
  let priorSpans: SemanticSpan[] = [];
  const priorScopes = new Set<string>();
  const priorExternalAssumptions = new Set<string>();

  const tasks = plan.tasks.map((task) => {
    const resolved = task.scopes.map((scope) => resolveScope(report, scope, readSource));
    let trusted: SemanticSpan[] = [];
    const assumptions = new Set<string>();
    for (const scope of resolved) {
      trusted = semanticSpanUnion(trusted, scope.spans);
      for (const assumption of scope.report.external_assumptions ?? []) assumptions.add(assumption);
    }

    const trustedLoc = semanticSpanLoc(trusted);
    const marginal = semanticSpanDifference(trusted, priorSpans);
    const marginalLoc = contributionSemanticLoc(marginal);
    const reusedLoc = trustedLoc - marginalLoc;
    if (reusedLoc < 0) throw new Error('SEMANTIC_SCALING_TCB_REUSED_LOC_INVALID');

    const introduced = resolved.filter((scope) => !priorScopes.has(scope.key));
    const introducedAssumptions = [...assumptions]
      .filter((assumption) => !priorExternalAssumptions.has(assumption))
      .sort();

    const marginalForRole = (role: SemanticScalingScopeRole): number => {
      let roleSpans: SemanticSpan[] = [];
      for (const scope of resolved) {
        if (scope.role === role) roleSpans = semanticSpanUnion(roleSpans, scope.spans);
      }
      return contributionSemanticLoc(semanticSpanDifference(roleSpans, priorSpans));
    };

    const result = {
      task_id: task.task_id,
      rung: task.rung,
      classification: task.classification,
      claim: task.claim,
      narrowed_from: task.narrowed_from ?? null,
      residual_judgment: task.residual_judgment ?? null,
      trusted_semantic_loc: trustedLoc,
      marginal_semantic_loc: marginalLoc,
      reused_prior_semantic_loc: reusedLoc,
      marginal_unit_sha256: digestSpanContributions(marginal),
      marginal_files: [...new Set(marginal.map((contribution) => contribution.path))].sort(),
      introduced_scopes: introduced
        .map((scope) => ({
          key: scope.key,
          role: scope.role,
          hybrid_closure_semantic_loc: scope.report.hybrid_closure_semantic_loc,
          hybrid_closure_sha256: scope.report.hybrid_closure_sha256,
          scope_sha256: scope.report.scope_sha256 ?? null,
        }))
        .sort((left, right) => left.key.localeCompare(right.key)),
      introduced_external_assumptions: introducedAssumptions,
      task_specific_marginal_semantic_loc: marginalForRole('task-specific'),
      provider_specific_marginal_semantic_loc: marginalForRole('provider-specific'),
      new_reusable_marginal_semantic_loc: marginalForRole('new-reusable'),
      evidence: [...task.evidence].sort(),
      observation_support: [...task.observation_support].sort(),
    };

    priorSpans = semanticSpanUnion(priorSpans, trusted);
    for (const scope of resolved) priorScopes.add(scope.key);
    for (const assumption of assumptions) priorExternalAssumptions.add(assumption);
    return result;
  });

  return {
    schema: SEMANTIC_SCALING_MEASUREMENT_RESULT_SCHEMA,
    source_revision: sourceRevision,
    tcb_report_sha256: tcbReportSha256,
    plan_sha256: planSha256,
    tasks,
  };
}

export function semanticScalingSummary(result: SemanticScalingMeasurementResult): string {
  const rows = result.tasks.map(
    (task) =>
      `| \`${task.task_id}\` | ${task.rung} | ${task.classification} | ${task.trusted_semantic_loc.toLocaleString('en-US')} | +${task.marginal_semantic_loc.toLocaleString('en-US')} | +${task.task_specific_marginal_semantic_loc.toLocaleString('en-US')} | +${task.provider_specific_marginal_semantic_loc.toLocaleString('en-US')} | ${task.introduced_scopes.map((scope) => `\`${scope.key}\` (${scope.role})`).join('<br>') || '_none_'} | ${task.introduced_external_assumptions.length} | ${task.residual_judgment ?? '_none_'} |`,
  );
  return [
    '## Semantic scaling marginal TCB',
    '',
    `Exact source revision: \`${result.source_revision}\``,
    '',
    '| Task | Rung | Classification | Trusted semantic LOC | Marginal vs prior ladder | Task-specific marginal | Provider-specific marginal | Introduced scopes | New external assumptions | Residual judgment |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | --- |',
    ...rows,
    '',
    'Marginal LOC is a deduplicated semantic-span projection reconstructed from the existing TCB report using its declared semantic-LOC basis. Scope identities, roles, fingerprints, external-assumption deltas, and residual judgments remain separate so a zero-LOC delta cannot erase semantic growth or a judgment frontier.',
    '',
  ].join('\n');
}

function main(): void {
  const tcbReportPath = optionValue('--tcb-report');
  if (!tcbReportPath) throw new Error('SEMANTIC_SCALING_TCB_REPORT_REQUIRED');
  const planPath = optionValue('--plan') ?? 'experiments/semantic-scaling/measurement-plan.json';

  const tcbBytes = readFileSync(tcbReportPath, 'utf8');
  const planBytes = readFileSync(planPath, 'utf8');
  const report = validateTcbReport(JSON.parse(tcbBytes));
  const plan = validateSemanticScalingMeasurementPlan(JSON.parse(planBytes));
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const result = measureSemanticScaling(
    plan,
    report,
    sourceRevision,
    sha256(tcbBytes),
    sha256(planBytes),
  );

  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  const outputPath = optionValue('--output');
  if (outputPath) writeFileSync(outputPath, rendered, 'utf8');

  const summaryPath = optionValue('--summary');
  if (summaryPath) {
    writeFileSync(summaryPath, semanticScalingSummary(result), { encoding: 'utf8', flag: 'a' });
  }

  process.stdout.write(rendered);
}

if (process.argv[1]?.endsWith('measure.ts')) main();
