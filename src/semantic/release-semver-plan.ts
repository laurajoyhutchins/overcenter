import { normalizeProjectVersionImpact } from './project-version-impact.js';
import type { ProjectVersionImpact, ProjectVersionImpactLevel } from './project-version-impact.js';

export const RELEASE_SEMVER_PLAN_SCHEMA = 'release-semver-plan-v1' as const;

export type ReleaseSemverAuthority = Readonly<{
  kind: 'github';
  repository: string;
  revision: string;
  derivation: string;
}>;

export type ReleaseSemverHorizon = Readonly<{
  schema: 'project-horizon-v1';
  kind: 'release';
  ref: string;
  authority: ReleaseSemverAuthority;
  authority_key: string;
  target_node_ids: readonly string[];
  scope_node_ids: readonly string[];
}>;

export type ReleaseSemverBase = Readonly<{
  version: string;
  included_transition_ids: readonly string[];
}>;

export type ReleaseSemverTransition = Readonly<{
  id: string;
  version_impact?: ProjectVersionImpact;
}>;

export type ReleaseSemverPlan = Readonly<{
  schema: typeof RELEASE_SEMVER_PLAN_SCHEMA;
  project_ref: string;
  authority: ReleaseSemverAuthority;
  horizon: Readonly<{
    kind: 'release';
    ref: string;
    target_node_ids: readonly string[];
    scope_node_ids: readonly string[];
  }>;
  base_release: ReleaseSemverBase;
  candidate_transition_ids: readonly string[];
  impacts: readonly Readonly<{ transition_id: string; level: ProjectVersionImpactLevel; summary: string }>[];
  aggregate_impact: ProjectVersionImpactLevel;
  candidate_version: string;
  release_required: boolean;
  breaking: boolean;
  fingerprint: string;
}>;

const IMPACT_RANK: Readonly<Record<ProjectVersionImpactLevel, number>> = Object.freeze({
  none: 0,
  patch: 1,
  minor: 2,
  major: 3,
});

function fail(code: string, message: string, details: unknown = null): never {
  const error = new Error(message);
  Object.assign(error, { code, details });
  throw error;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('RELEASE_SEMVER_PLAN_INVALID', `${field} must be an object`, { field });
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail('RELEASE_SEMVER_PLAN_INVALID', `${field} must be a non-empty string`, { field });
  return normalized;
}

function exactRevision(value: unknown, field: string): string {
  const revision = text(value, field).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    fail('RELEASE_SEMVER_PLAN_INVALID', `${field} must be a full Git commit SHA`, { field, revision });
  }
  return revision;
}

function normalizeAuthority(raw: unknown, field: string): ReleaseSemverAuthority {
  const input = record(raw, field);
  const kind = text(input.kind, `${field}.kind`).toLowerCase();
  if (kind !== 'github') fail('RELEASE_SEMVER_PLAN_INVALID', `${field}.kind must be github`, { kind });
  return Object.freeze({
    kind: 'github',
    repository: text(input.repository, `${field}.repository`),
    revision: exactRevision(input.revision, `${field}.revision`),
    derivation: text(input.derivation, `${field}.derivation`),
  });
}

function authorityKey(authority: ReleaseSemverAuthority): string {
  return `${authority.kind}:${authority.repository}@${authority.revision}#${authority.derivation}`;
}

function normalizeStringArray(raw: unknown, field: string): readonly string[] {
  if (!Array.isArray(raw)) fail('RELEASE_SEMVER_PLAN_INVALID', `${field} must be an array`, { field });
  const values = raw.map((value, index) => text(value, `${field}[${index}]`));
  if (new Set(values).size !== values.length) {
    fail('RELEASE_SEMVER_PLAN_INVALID', `${field} must contain unique ids`, { field });
  }
  return Object.freeze([...values].sort());
}

function stableVersion(value: unknown, field: string): Readonly<{ raw: string; major: number; minor: number; patch: number }> {
  const raw = text(value, field);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(raw);
  if (!match) {
    fail('RELEASE_SEMVER_PLAN_INVALID', `${field} must be a stable semantic version in X.Y.Z form`, { field, version: raw });
  }
  return Object.freeze({ raw, major:Number(match[1]), minor:Number(match[2]), patch:Number(match[3]) });
}

export function bumpStableSemver(baseVersion: string, impact: ProjectVersionImpactLevel): string {
  const base = stableVersion(baseVersion, 'base_version');
  if (!(impact in IMPACT_RANK)) fail('RELEASE_SEMVER_PLAN_INVALID', 'impact level is unsupported', { impact });
  if (impact === 'none') return base.raw;
  if (impact === 'patch') return `${base.major}.${base.minor}.${base.patch + 1}`;
  if (impact === 'minor') return `${base.major}.${base.minor + 1}.0`;
  if (base.major === 0) return `0.${base.minor + 1}.0`;
  return `${base.major + 1}.0.0`;
}

function aggregateImpact(impacts: readonly ProjectVersionImpact[]): ProjectVersionImpactLevel {
  let selected: ProjectVersionImpactLevel = 'none';
  for (const impact of impacts) {
    if (IMPACT_RANK[impact.level] > IMPACT_RANK[selected]) selected = impact.level;
  }
  return selected;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function deriveReleaseSemverPlan(raw: unknown): Promise<ReleaseSemverPlan> {
  const input = record(raw, 'release_plan');
  const projectRef = text(input.project_ref, 'project_ref');
  const authority = normalizeAuthority(input.authority, 'authority');
  const horizonInput = record(input.horizon, 'horizon');
  if (horizonInput.schema !== 'project-horizon-v1' || String(horizonInput.kind || '').trim().toLowerCase() !== 'release') {
    fail('RELEASE_SEMVER_HORIZON_REQUIRED', 'release SemVer planning requires a resolved release horizon');
  }
  const horizonAuthority = normalizeAuthority(horizonInput.authority, 'horizon.authority');
  if (authorityKey(horizonAuthority) !== authorityKey(authority)) {
    fail('RELEASE_SEMVER_AUTHORITY_STALE', 'release horizon authority does not match the exact project authority', {
      expected: authority,
      actual: horizonAuthority,
    });
  }
  const observedAuthorityKey = text(horizonInput.authority_key, 'horizon.authority_key');
  if (observedAuthorityKey !== authorityKey(authority)) {
    fail('RELEASE_SEMVER_AUTHORITY_STALE', 'release horizon authority key does not match the exact project authority');
  }
  const horizonRef = text(horizonInput.ref, 'horizon.ref');
  const targetNodeIds = normalizeStringArray(horizonInput.target_node_ids, 'horizon.target_node_ids');
  const scopeNodeIds = normalizeStringArray(horizonInput.scope_node_ids, 'horizon.scope_node_ids');
  if (scopeNodeIds.length === 0) fail('RELEASE_SEMVER_PLAN_INVALID', 'release horizon scope must not be empty');
  const scopeSet = new Set(scopeNodeIds);
  const targetsOutsideScope = targetNodeIds.filter((id) => !scopeSet.has(id));
  if (targetsOutsideScope.length) {
    fail('RELEASE_SEMVER_PLAN_INVALID', 'release horizon targets must be included in dependency-closed scope', {
      transition_ids: targetsOutsideScope,
    });
  }

  const baseInput = record(input.base_release, 'base_release');
  const baseVersion = stableVersion(baseInput.version, 'base_release.version').raw;
  const baseIncludedIds = normalizeStringArray(baseInput.included_transition_ids, 'base_release.included_transition_ids');
  const baseIncludedSet = new Set(baseIncludedIds);

  if (!Array.isArray(input.transitions)) fail('RELEASE_SEMVER_PLAN_INVALID', 'transitions must be an array');
  const transitions = input.transitions.map((rawTransition, index) => {
    const transition = record(rawTransition, `transitions[${index}]`);
    const id = text(transition.id, `transitions[${index}].id`);
    const versionImpact = normalizeProjectVersionImpact(
      transition.version_impact,
      id,
      (_code, message, details) => fail('RELEASE_SEMVER_PLAN_INVALID', message, details),
    );
    return Object.freeze({ id, version_impact:versionImpact });
  });
  const byId = new Map<string, (typeof transitions)[number]>();
  for (const transition of transitions) {
    if (byId.has(transition.id)) fail('RELEASE_SEMVER_PLAN_INVALID', 'transition ids must be unique', { transition_id:transition.id });
    byId.set(transition.id, transition);
  }
  const missingDefinitions = scopeNodeIds.filter((id) => !byId.has(id));
  if (missingDefinitions.length) {
    fail('RELEASE_SEMVER_PLAN_INVALID', 'release horizon scope is missing exact-revision transition definitions', {
      transition_ids:missingDefinitions,
    });
  }

  const candidateTransitionIds = Object.freeze(scopeNodeIds.filter((id) => !baseIncludedSet.has(id)));
  const missingImpact = candidateTransitionIds.filter((id) => !byId.get(id)?.version_impact);
  if (missingImpact.length) {
    fail('RELEASE_SEMVER_IMPACT_REQUIRED', 'every newly included release transition must declare version_impact', {
      transition_ids:missingImpact,
    });
  }
  const impacts = Object.freeze(candidateTransitionIds.map((id) => {
    const impact = byId.get(id)!.version_impact!;
    return Object.freeze({ transition_id:id, level:impact.level, summary:impact.summary });
  }));
  const aggregate = aggregateImpact(impacts.map((entry) => Object.freeze({ level:entry.level, summary:entry.summary })));
  const candidateVersion = bumpStableSemver(baseVersion, aggregate);
  const baseRelease = Object.freeze({ version:baseVersion, included_transition_ids:baseIncludedIds });
  const horizon = Object.freeze({
    kind:'release' as const,
    ref:horizonRef,
    target_node_ids:targetNodeIds,
    scope_node_ids:scopeNodeIds,
  });
  const fingerprintPayload = Object.freeze({
    schema:'release-semver-plan-fingerprint-v1',
    project_ref:projectRef,
    authority,
    horizon,
    base_release:baseRelease,
    candidate_transition_ids:candidateTransitionIds,
    impacts,
    aggregate_impact:aggregate,
    candidate_version:candidateVersion,
  });
  const fingerprint = await sha256Text(JSON.stringify(fingerprintPayload));

  return Object.freeze({
    schema:RELEASE_SEMVER_PLAN_SCHEMA,
    project_ref:projectRef,
    authority,
    horizon,
    base_release:baseRelease,
    candidate_transition_ids:candidateTransitionIds,
    impacts,
    aggregate_impact:aggregate,
    candidate_version:candidateVersion,
    release_required:candidateVersion !== baseVersion,
    breaking:aggregate === 'major',
    fingerprint,
  });
}
