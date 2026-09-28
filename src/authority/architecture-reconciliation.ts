import { canonicalDigest } from '../digest.ts';
import type {
  GitHubActionsExplicitWriteCapabilityFact,
  GitHubActionsInheritedPermissionsFact,
  GitHubActionsWorkflowScanFact,
} from '../observation/github-actions-capabilities.ts';
import type {
  GitHubActionsProviderEffect,
  GitHubActionsProviderEffectInvocationFact,
} from '../observation/github-actions-effects.ts';
import type {
  WorkflowReachableProductionEffect,
  WorkflowEntrypointFact,
  WorkflowTransitiveEffectFact,
  WorkflowUnresolvedDynamicCallFact,
} from '../observation/workflow-transitive-effects.ts';
import { assertNonEmptyString, isData } from '../validation.ts';
import type { ObligationInput } from './facts.ts';

export const ARCHITECTURE_INTENT_SCHEMA = 'overcenter-architecture-intent/v1' as const;
export const ARCHITECTURE_RECONCILIATION_SCHEMA =
  'overcenter-architecture-reconciliation/v1' as const;
export const ARCHITECTURE_RECONCILIATION_TASK_SCHEMA =
  'overcenter-architecture-reconciliation-task/v1' as const;

export interface AuthorityRoleIntentClaim {
  kind: 'authority-role';
  concept: string;
  authority: string;
  projections: string[];
  verifiers: string[];
}

export interface GitHubActionsExplicitWriteGrant {
  workflow: string;
  permissions: string[];
}

export interface GitHubActionsExplicitWriteAuthorityIntentClaim {
  kind: 'github-actions-explicit-write-authority';
  concept: string;
  allowed: GitHubActionsExplicitWriteGrant[];
}

export interface GitHubActionsProviderEffectGrant {
  workflow: string;
  effects: GitHubActionsProviderEffect[];
}

export interface GitHubActionsProviderEffectAuthorityIntentClaim {
  kind: 'github-actions-provider-effect-authority';
  concept: string;
  allowed: GitHubActionsProviderEffectGrant[];
}

export interface WorkflowTransitiveEffectGrant {
  workflow: string;
  effects: WorkflowReachableProductionEffect[];
}

export interface WorkflowTransitiveEffectAuthorityIntentClaim {
  kind: 'workflow-transitive-effect-authority';
  concept: string;
  allowed: WorkflowTransitiveEffectGrant[];
}

export type ArchitectureIntentClaim =
  | AuthorityRoleIntentClaim
  | GitHubActionsExplicitWriteAuthorityIntentClaim
  | GitHubActionsProviderEffectAuthorityIntentClaim
  | WorkflowTransitiveEffectAuthorityIntentClaim;

export interface ArchitectureIntent {
  schema: typeof ARCHITECTURE_INTENT_SCHEMA;
  claims: ArchitectureIntentClaim[];
}

export interface PathStateFact {
  kind: 'path-state';
  source_revision: string;
  path: string;
  present: boolean;
}

export interface TypeScriptReferenceStateFact {
  kind: 'typescript-reference-state';
  source_revision: string;
  from_path: string;
  to_path: string;
  present: boolean;
}

export type ArchitectureObservedFact =
  | PathStateFact
  | TypeScriptReferenceStateFact
  | GitHubActionsWorkflowScanFact
  | GitHubActionsExplicitWriteCapabilityFact
  | GitHubActionsInheritedPermissionsFact
  | GitHubActionsProviderEffectInvocationFact
  | WorkflowEntrypointFact
  | WorkflowTransitiveEffectFact
  | WorkflowUnresolvedDynamicCallFact;

export type ArchitectureConflictReasonCode =
  | 'DUPLICATE_CONCEPT'
  | 'DUPLICATE_AUTHORITY_OWNER'
  | 'AUTHORITY_PATH_MISSING'
  | 'PROJECTION_PATH_MISSING'
  | 'VERIFIER_PATH_MISSING'
  | 'AUTHORITY_ALSO_PROJECTION'
  | 'DECLARED_PROJECTION_FLOW_MISSING'
  | 'UNDECLARED_GITHUB_ACTIONS_EXPLICIT_WRITE_CAPABILITY'
  | 'UNDECLARED_GITHUB_ACTIONS_PROVIDER_EFFECT'
  | 'UNDECLARED_WORKFLOW_TRANSITIVE_EFFECT'
  | 'UNKNOWN_DYNAMIC_CALL_TARGET';

export interface EstablishedArchitectureResolution {
  state: 'established';
  claim: ArchitectureIntentClaim;
  supporting_facts: ArchitectureObservedFact[];
}

export interface ConflictedArchitectureResolution {
  state: 'conflict';
  claim: ArchitectureIntentClaim;
  reason_code: ArchitectureConflictReasonCode;
  supporting_facts: ArchitectureObservedFact[];
  contradicting_facts: ArchitectureObservedFact[];
}

export interface UnknownArchitectureResolution {
  state: 'unknown';
  claim: ArchitectureIntentClaim;
  missing_evidence: string[];
  supporting_facts: ArchitectureObservedFact[];
}

export type ArchitectureResolution =
  | EstablishedArchitectureResolution
  | ConflictedArchitectureResolution
  | UnknownArchitectureResolution;

export interface ArchitectureReconciliation {
  schema: typeof ARCHITECTURE_RECONCILIATION_SCHEMA;
  source_revision: string;
  resolutions: ArchitectureResolution[];
}

export interface ArchitectureReconciliationInput {
  intent: ArchitectureIntent;
  source_revision: string;
  observations: ArchitectureObservedFact[];
}

function stringArray(value: unknown, error: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(error);
  }
}

function workflowGrants(
  value: unknown,
  field: 'permissions' | 'effects',
  grantError: string,
  valuesError: string,
  emptyError: string,
): Array<{ workflow: string; values: string[] }> {
  if (!Array.isArray(value)) throw new Error('ARCHITECTURE_INTENT_ALLOWED_INVALID');
  return value.map((candidate) => {
    if (!isData(candidate)) throw new Error(grantError);
    assertNonEmptyString(candidate.workflow, 'ARCHITECTURE_INTENT_WORKFLOW_INVALID');
    const values = candidate[field];
    stringArray(values, valuesError);
    if (values.length === 0) throw new Error(emptyError);
    return {
      workflow: candidate.workflow,
      values: [...new Set(values)].sort(),
    };
  });
}

export function validateArchitectureIntent(value: unknown): ArchitectureIntent {
  if (!isData(value)) throw new Error('ARCHITECTURE_INTENT_INVALID');
  const record = value;
  if (record.schema !== ARCHITECTURE_INTENT_SCHEMA || !Array.isArray(record.claims)) {
    throw new Error('ARCHITECTURE_INTENT_SCHEMA_UNSUPPORTED');
  }

  const claims = record.claims.map((candidate): ArchitectureIntentClaim => {
    if (!isData(candidate)) throw new Error('ARCHITECTURE_INTENT_CLAIM_INVALID');
    const claim = candidate;
    assertNonEmptyString(claim.concept, 'ARCHITECTURE_INTENT_CONCEPT_INVALID');

    if (claim.kind === 'authority-role') {
      assertNonEmptyString(claim.authority, 'ARCHITECTURE_INTENT_AUTHORITY_INVALID');
      stringArray(claim.projections, 'ARCHITECTURE_INTENT_PROJECTIONS_INVALID');
      stringArray(claim.verifiers, 'ARCHITECTURE_INTENT_VERIFIERS_INVALID');
      return {
        kind: 'authority-role',
        concept: claim.concept,
        authority: claim.authority,
        projections: [...claim.projections],
        verifiers: [...claim.verifiers],
      };
    }

    if (claim.kind === 'github-actions-explicit-write-authority') {
      const allowed = workflowGrants(
        claim.allowed,
        'permissions',
        'ARCHITECTURE_INTENT_WRITE_GRANT_INVALID',
        'ARCHITECTURE_INTENT_PERMISSIONS_INVALID',
        'ARCHITECTURE_INTENT_PERMISSIONS_EMPTY',
      );
      return {
        kind: claim.kind,
        concept: claim.concept,
        allowed: allowed
          .map(({ workflow, values }) => ({ workflow, permissions: values }))
          .sort((left, right) => left.workflow.localeCompare(right.workflow)),
      };
    }

    if (claim.kind === 'github-actions-provider-effect-authority') {
      const allowed = workflowGrants(
        claim.allowed,
        'effects',
        'ARCHITECTURE_INTENT_EFFECT_GRANT_INVALID',
        'ARCHITECTURE_INTENT_EFFECTS_INVALID',
        'ARCHITECTURE_INTENT_EFFECTS_EMPTY',
      );
      return {
        kind: claim.kind,
        concept: claim.concept,
        allowed: allowed
          .map(({ workflow, values }) => ({
            workflow,
            effects: values as GitHubActionsProviderEffect[],
          }))
          .sort((left, right) => left.workflow.localeCompare(right.workflow)),
      };
    }

    if (claim.kind === 'workflow-transitive-effect-authority') {
      const allowed = workflowGrants(
        claim.allowed,
        'effects',
        'ARCHITECTURE_INTENT_TRANSITIVE_EFFECT_GRANT_INVALID',
        'ARCHITECTURE_INTENT_EFFECTS_INVALID',
        'ARCHITECTURE_INTENT_EFFECTS_EMPTY',
      );
      return {
        kind: claim.kind,
        concept: claim.concept,
        allowed: allowed
          .map(({ workflow, values }) => ({
            workflow,
            effects: values as WorkflowReachableProductionEffect[],
          }))
          .sort((left, right) => left.workflow.localeCompare(right.workflow)),
      };
    }

    throw new Error('ARCHITECTURE_INTENT_KIND_UNSUPPORTED');
  });

  return { schema: ARCHITECTURE_INTENT_SCHEMA, claims };
}

function factKey(fact: ArchitectureObservedFact): string {
  switch (fact.kind) {
    case 'path-state':
      return `path:${fact.path}`;
    case 'typescript-reference-state':
      return `reference:${fact.from_path}->${fact.to_path}`;
    case 'github-actions-workflow-scan':
      return `github-actions-scan:${fact.workflow_paths.join(',')}`;
    case 'github-actions-explicit-write-capability':
      return `github-actions-write:${fact.workflow_path}:${fact.permission}`;
    case 'github-actions-inherited-permissions':
      return `github-actions-inherited:${fact.workflow_path}`;
    case 'github-actions-provider-effect-invocation':
      return `github-actions-effect:${fact.workflow_path}:${fact.effect}:${fact.line_number}:${fact.statement_sha256}`;
    case 'github-actions-typescript-entrypoint':
      return `workflow-entrypoint:${fact.workflow_path}:${fact.entrypoint}:${fact.line_number}`;
    case 'github-actions-transitive-effect-reachability':
      return `workflow-transitive-effect:${fact.workflow_path}:${fact.entrypoint}:${fact.effect}:${fact.terminal_path}:${fact.terminal_statement_sha256}`;
    case 'github-actions-unresolved-dynamic-call-target':
      return `workflow-unresolved-call:${fact.workflow_path}:${fact.entrypoint}:${fact.call_site_path}:${fact.call_site_line}:${fact.call_expression_sha256}:${fact.candidate_effects.join(',')}`;
  }
}

function sortFacts(facts: ArchitectureObservedFact[]): ArchitectureObservedFact[] {
  return [...facts].sort((left, right) => factKey(left).localeCompare(factKey(right)));
}

function sortResolutions(resolutions: ArchitectureResolution[]): ArchitectureResolution[] {
  return [...resolutions].sort((left, right) => {
    const concept = left.claim.concept.localeCompare(right.claim.concept);
    if (concept !== 0) return concept;
    const leftReason = left.state === 'conflict' ? left.reason_code : left.state;
    const rightReason = right.state === 'conflict' ? right.reason_code : right.state;
    return leftReason.localeCompare(rightReason);
  });
}

function pathFact(
  observations: ArchitectureObservedFact[],
  path: string,
): PathStateFact | undefined {
  return observations.find(
    (fact): fact is PathStateFact => fact.kind === 'path-state' && fact.path === path,
  );
}

function referenceFact(
  observations: ArchitectureObservedFact[],
  fromPath: string,
  toPath: string,
): TypeScriptReferenceStateFact | undefined {
  return observations.find(
    (fact): fact is TypeScriptReferenceStateFact =>
      fact.kind === 'typescript-reference-state' &&
      fact.from_path === fromPath &&
      fact.to_path === toPath,
  );
}

function conflict(
  claim: ArchitectureIntentClaim,
  reasonCode: ArchitectureConflictReasonCode,
  supportingFacts: ArchitectureObservedFact[] = [],
  contradictingFacts: ArchitectureObservedFact[] = [],
): ConflictedArchitectureResolution {
  return {
    state: 'conflict',
    claim: structuredClone(claim),
    reason_code: reasonCode,
    supporting_facts: sortFacts(supportingFacts),
    contradicting_facts: sortFacts(contradictingFacts),
  };
}

function reconcileAuthorityRoleClaim(
  claim: AuthorityRoleIntentClaim,
  observations: ArchitectureObservedFact[],
): ArchitectureResolution {
  const supporting: ArchitectureObservedFact[] = [];
  const missingEvidence: string[] = [];

  const authority = pathFact(observations, claim.authority);
  if (!authority) {
    missingEvidence.push(`path-state:${claim.authority}`);
  } else if (!authority.present) {
    return conflict(claim, 'AUTHORITY_PATH_MISSING', [], [authority]);
  } else {
    supporting.push(authority);
  }

  for (const projection of [...claim.projections].sort()) {
    if (projection === claim.authority) {
      return conflict(claim, 'AUTHORITY_ALSO_PROJECTION');
    }
    const projectionPath = pathFact(observations, projection);
    if (!projectionPath) {
      missingEvidence.push(`path-state:${projection}`);
      continue;
    }
    if (!projectionPath.present) {
      return conflict(claim, 'PROJECTION_PATH_MISSING', supporting, [projectionPath]);
    }
    supporting.push(projectionPath);

    if (!authority?.present) continue;
    const forward = referenceFact(observations, claim.authority, projection);
    const reverse = referenceFact(observations, projection, claim.authority);
    if (forward?.present || reverse?.present) {
      if (forward) supporting.push(forward);
      if (reverse) supporting.push(reverse);
      continue;
    }
    if (forward && reverse) {
      return conflict(claim, 'DECLARED_PROJECTION_FLOW_MISSING', supporting, [forward, reverse]);
    }
    if (!forward) {
      missingEvidence.push(`typescript-reference-state:${claim.authority}->${projection}`);
    }
    if (!reverse) {
      missingEvidence.push(`typescript-reference-state:${projection}->${claim.authority}`);
    }
  }

  for (const verifier of [...claim.verifiers].sort()) {
    const verifierPath = pathFact(observations, verifier);
    if (!verifierPath) {
      missingEvidence.push(`path-state:${verifier}`);
    } else if (!verifierPath.present) {
      return conflict(claim, 'VERIFIER_PATH_MISSING', supporting, [verifierPath]);
    } else {
      supporting.push(verifierPath);
    }
  }

  if (missingEvidence.length > 0) {
    return {
      state: 'unknown',
      claim: structuredClone(claim),
      missing_evidence: [...new Set(missingEvidence)].sort(),
      supporting_facts: sortFacts(supporting),
    };
  }

  return {
    state: 'established',
    claim: structuredClone(claim),
    supporting_facts: sortFacts(supporting),
  };
}

function reconcileWorkflowFacts<TFact extends ArchitectureObservedFact & { workflow_path: string }>(
  claim: ArchitectureIntentClaim,
  observations: ArchitectureObservedFact[],
  facts: TFact[],
  allowed: (fact: TFact) => boolean,
  reasonCode: ArchitectureConflictReasonCode,
  extraSupporting: ArchitectureObservedFact[] = [],
): ArchitectureResolution {
  const scan = observations.find(
    (fact): fact is GitHubActionsWorkflowScanFact => fact.kind === 'github-actions-workflow-scan',
  );
  if (!scan) {
    return {
      state: 'unknown',
      claim: structuredClone(claim),
      missing_evidence: ['github-actions-workflow-scan'],
      supporting_facts: [],
    };
  }

  const undeclared = facts.filter((fact) => !allowed(fact));
  const supporting = [
    scan,
    ...facts.filter((fact) => !undeclared.includes(fact)),
    ...extraSupporting,
  ];
  if (undeclared.length > 0) {
    return conflict(claim, reasonCode, supporting, undeclared);
  }
  return {
    state: 'established',
    claim: structuredClone(claim),
    supporting_facts: sortFacts(supporting),
  };
}

function reconcileGitHubActionsExplicitWriteClaim(
  claim: GitHubActionsExplicitWriteAuthorityIntentClaim,
  observations: ArchitectureObservedFact[],
): ArchitectureResolution {
  const writes = observations.filter(
    (fact): fact is GitHubActionsExplicitWriteCapabilityFact =>
      fact.kind === 'github-actions-explicit-write-capability',
  );
  const inherited = observations.filter(
    (fact): fact is GitHubActionsInheritedPermissionsFact =>
      fact.kind === 'github-actions-inherited-permissions',
  );
  const allowed = new Map(
    claim.allowed.map((grant) => [grant.workflow, new Set(grant.permissions)] as const),
  );
  return reconcileWorkflowFacts(
    claim,
    observations,
    writes,
    (fact) => {
      const permissions = allowed.get(fact.workflow_path);
      return !!permissions && (permissions.has(fact.permission) || permissions.has('*'));
    },
    'UNDECLARED_GITHUB_ACTIONS_EXPLICIT_WRITE_CAPABILITY',
    inherited,
  );
}

function reconcileGitHubActionsProviderEffectClaim(
  claim: GitHubActionsProviderEffectAuthorityIntentClaim,
  observations: ArchitectureObservedFact[],
): ArchitectureResolution {
  const effects = observations.filter(
    (fact): fact is GitHubActionsProviderEffectInvocationFact =>
      fact.kind === 'github-actions-provider-effect-invocation',
  );
  const allowed = new Map(
    claim.allowed.map((grant) => [grant.workflow, new Set(grant.effects)] as const),
  );
  return reconcileWorkflowFacts(
    claim,
    observations,
    effects,
    (fact) => allowed.get(fact.workflow_path)?.has(fact.effect) === true,
    'UNDECLARED_GITHUB_ACTIONS_PROVIDER_EFFECT',
  );
}

function reconcileWorkflowTransitiveEffectClaim(
  claim: WorkflowTransitiveEffectAuthorityIntentClaim,
  observations: ArchitectureObservedFact[],
): ArchitectureResolution {
  const scan = observations.find(
    (fact): fact is GitHubActionsWorkflowScanFact => fact.kind === 'github-actions-workflow-scan',
  );
  if (!scan) {
    return {
      state: 'unknown',
      claim: structuredClone(claim),
      missing_evidence: ['github-actions-workflow-scan'],
      supporting_facts: [],
    };
  }

  const entrypoints = observations.filter(
    (fact): fact is WorkflowEntrypointFact => fact.kind === 'github-actions-typescript-entrypoint',
  );
  const effects = observations.filter(
    (fact): fact is WorkflowTransitiveEffectFact =>
      fact.kind === 'github-actions-transitive-effect-reachability',
  );
  const unresolvedCalls = observations.filter(
    (fact): fact is WorkflowUnresolvedDynamicCallFact =>
      fact.kind === 'github-actions-unresolved-dynamic-call-target',
  );
  const allowed = new Map(
    claim.allowed.map((grant) => [grant.workflow, new Set(grant.effects)] as const),
  );
  const undeclared = effects.filter((fact) => {
    const workflowEffects = allowed.get(fact.workflow_path);
    return !workflowEffects || !workflowEffects.has(fact.effect);
  });

  if (undeclared.length > 0) {
    return conflict(
      claim,
      'UNDECLARED_WORKFLOW_TRANSITIVE_EFFECT',
      [scan, ...entrypoints, ...effects.filter((fact) => !undeclared.includes(fact))],
      undeclared,
    );
  }

  const effectRelevantUnresolved = unresolvedCalls.filter(
    (fact) => fact.candidate_effects.length > 0,
  );
  const resolvedUncertainty = unresolvedCalls.filter((fact) => fact.candidate_effects.length === 0);
  if (effectRelevantUnresolved.length > 0) {
    return conflict(
      claim,
      'UNKNOWN_DYNAMIC_CALL_TARGET',
      [scan, ...entrypoints, ...effects, ...resolvedUncertainty],
      effectRelevantUnresolved,
    );
  }

  return {
    state: 'established',
    claim: structuredClone(claim),
    supporting_facts: sortFacts([scan, ...entrypoints, ...effects, ...unresolvedCalls]),
  };
}

export function reconcileArchitecture({
  intent: rawIntent,
  source_revision: sourceRevision,
  observations,
}: ArchitectureReconciliationInput): ArchitectureReconciliation {
  const intent = validateArchitectureIntent(rawIntent);
  assertNonEmptyString(sourceRevision, 'ARCHITECTURE_SOURCE_REVISION_INVALID');
  for (const fact of observations) {
    if (fact.source_revision !== sourceRevision) {
      throw new Error('ARCHITECTURE_OBSERVATION_REVISION_MISMATCH');
    }
  }

  const resolutions: ArchitectureResolution[] = [];
  const concepts = new Map<string, ArchitectureIntentClaim[]>();
  const owners = new Map<string, AuthorityRoleIntentClaim[]>();
  for (const claim of intent.claims) {
    const byConcept = concepts.get(claim.concept) ?? [];
    byConcept.push(claim);
    concepts.set(claim.concept, byConcept);
    if (claim.kind === 'authority-role') {
      const byOwner = owners.get(claim.authority) ?? [];
      byOwner.push(claim);
      owners.set(claim.authority, byOwner);
    }
  }

  const conflicted = new Set<ArchitectureIntentClaim>();
  for (const claims of concepts.values()) {
    if (claims.length < 2) continue;
    for (const claim of claims) {
      conflicted.add(claim);
      resolutions.push(conflict(claim, 'DUPLICATE_CONCEPT'));
    }
  }
  for (const claims of owners.values()) {
    if (new Set(claims.map((claim) => claim.concept)).size < 2) continue;
    for (const claim of claims) {
      if (conflicted.has(claim)) continue;
      conflicted.add(claim);
      resolutions.push(conflict(claim, 'DUPLICATE_AUTHORITY_OWNER'));
    }
  }

  for (const claim of intent.claims) {
    if (conflicted.has(claim)) continue;
    resolutions.push(
      claim.kind === 'authority-role'
        ? reconcileAuthorityRoleClaim(claim, observations)
        : claim.kind === 'github-actions-explicit-write-authority'
          ? reconcileGitHubActionsExplicitWriteClaim(claim, observations)
          : claim.kind === 'github-actions-provider-effect-authority'
            ? reconcileGitHubActionsProviderEffectClaim(claim, observations)
            : reconcileWorkflowTransitiveEffectClaim(claim, observations),
    );
  }

  return {
    schema: ARCHITECTURE_RECONCILIATION_SCHEMA,
    source_revision: sourceRevision,
    resolutions: sortResolutions(resolutions),
  };
}

export function architectureReconciliationWork(
  resolution: ConflictedArchitectureResolution,
  sourceRevision: string,
): ObligationInput {
  assertNonEmptyString(sourceRevision, 'ARCHITECTURE_SOURCE_REVISION_INVALID');
  const identity = canonicalDigest({
    domain: 'overcenter-architecture-reconciliation-work',
    source_revision: sourceRevision,
    claim: resolution.claim,
    reason_code: resolution.reason_code,
    contradicting_facts: resolution.contradicting_facts,
  });
  const subject = {
    schema: ARCHITECTURE_RECONCILIATION_TASK_SCHEMA,
    kind: 'architecture-reconciliation',
    source_revision: sourceRevision,
    claim: structuredClone(resolution.claim),
    reason_code: resolution.reason_code,
    supporting_facts: structuredClone(resolution.supporting_facts),
    contradicting_facts: structuredClone(resolution.contradicting_facts),
  };
  return {
    id: `architecture-reconciliation:${identity}`,
    packet: structuredClone(subject),
    postcondition: {
      verifier: 'operator-judgment/v1',
      subject,
    },
  };
}
