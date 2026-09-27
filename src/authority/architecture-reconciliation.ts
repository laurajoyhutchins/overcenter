import { canonicalDigest } from '../digest.ts';
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

export interface ArchitectureIntent {
  schema: typeof ARCHITECTURE_INTENT_SCHEMA;
  claims: AuthorityRoleIntentClaim[];
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

export type ArchitectureObservedFact = PathStateFact | TypeScriptReferenceStateFact;

export type ArchitectureConflictReasonCode =
  | 'DUPLICATE_CONCEPT'
  | 'DUPLICATE_AUTHORITY_OWNER'
  | 'AUTHORITY_PATH_MISSING'
  | 'PROJECTION_PATH_MISSING'
  | 'VERIFIER_PATH_MISSING'
  | 'AUTHORITY_ALSO_PROJECTION'
  | 'DECLARED_PROJECTION_FLOW_MISSING';

export interface EstablishedArchitectureResolution {
  state: 'established';
  claim: AuthorityRoleIntentClaim;
  supporting_facts: ArchitectureObservedFact[];
}

export interface ConflictedArchitectureResolution {
  state: 'conflict';
  claim: AuthorityRoleIntentClaim;
  reason_code: ArchitectureConflictReasonCode;
  supporting_facts: ArchitectureObservedFact[];
  contradicting_facts: ArchitectureObservedFact[];
}

export interface UnknownArchitectureResolution {
  state: 'unknown';
  claim: AuthorityRoleIntentClaim;
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

function nonEmptyString(value: unknown, error: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(error);
}

function stringArray(value: unknown, error: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(error);
  }
}

export function validateArchitectureIntent(value: unknown): ArchitectureIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ARCHITECTURE_INTENT_INVALID');
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== ARCHITECTURE_INTENT_SCHEMA || !Array.isArray(record.claims)) {
    throw new Error('ARCHITECTURE_INTENT_SCHEMA_UNSUPPORTED');
  }

  const claims = record.claims.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('ARCHITECTURE_INTENT_CLAIM_INVALID');
    }
    const claim = candidate as Record<string, unknown>;
    if (claim.kind !== 'authority-role') throw new Error('ARCHITECTURE_INTENT_KIND_UNSUPPORTED');
    nonEmptyString(claim.concept, 'ARCHITECTURE_INTENT_CONCEPT_INVALID');
    nonEmptyString(claim.authority, 'ARCHITECTURE_INTENT_AUTHORITY_INVALID');
    stringArray(claim.projections, 'ARCHITECTURE_INTENT_PROJECTIONS_INVALID');
    stringArray(claim.verifiers, 'ARCHITECTURE_INTENT_VERIFIERS_INVALID');
    return {
      kind: 'authority-role' as const,
      concept: claim.concept,
      authority: claim.authority,
      projections: [...claim.projections],
      verifiers: [...claim.verifiers],
    };
  });

  return { schema: ARCHITECTURE_INTENT_SCHEMA, claims };
}

function factKey(fact: ArchitectureObservedFact): string {
  return fact.kind === 'path-state'
    ? `path:\${fact.path}`
    : `reference:\${fact.from_path}->\${fact.to_path}`;
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
  claim: AuthorityRoleIntentClaim,
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

function reconcileClaim(
  claim: AuthorityRoleIntentClaim,
  observations: ArchitectureObservedFact[],
): ArchitectureResolution {
  const supporting: ArchitectureObservedFact[] = [];
  const missingEvidence: string[] = [];

  const authority = pathFact(observations, claim.authority);
  if (!authority) {
    missingEvidence.push(`path-state:\${claim.authority}`);
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
      missingEvidence.push(`path-state:\${projection}`);
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
      missingEvidence.push(`typescript-reference-state:\${claim.authority}->\${projection}`);
    }
    if (!reverse) {
      missingEvidence.push(`typescript-reference-state:\${projection}->\${claim.authority}`);
    }
  }

  for (const verifier of [...claim.verifiers].sort()) {
    const verifierPath = pathFact(observations, verifier);
    if (!verifierPath) {
      missingEvidence.push(`path-state:\${verifier}`);
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

export function reconcileArchitecture({
  intent: rawIntent,
  source_revision: sourceRevision,
  observations,
}: ArchitectureReconciliationInput): ArchitectureReconciliation {
  const intent = validateArchitectureIntent(rawIntent);
  nonEmptyString(sourceRevision, 'ARCHITECTURE_SOURCE_REVISION_INVALID');
  for (const fact of observations) {
    if (fact.source_revision !== sourceRevision) {
      throw new Error('ARCHITECTURE_OBSERVATION_REVISION_MISMATCH');
    }
  }

  const resolutions: ArchitectureResolution[] = [];
  const concepts = new Map<string, AuthorityRoleIntentClaim[]>();
  const owners = new Map<string, AuthorityRoleIntentClaim[]>();
  for (const claim of intent.claims) {
    const byConcept = concepts.get(claim.concept) ?? [];
    byConcept.push(claim);
    concepts.set(claim.concept, byConcept);
    const byOwner = owners.get(claim.authority) ?? [];
    byOwner.push(claim);
    owners.set(claim.authority, byOwner);
  }

  const conflicted = new Set<AuthorityRoleIntentClaim>();
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
    if (!conflicted.has(claim)) resolutions.push(reconcileClaim(claim, observations));
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
  nonEmptyString(sourceRevision, 'ARCHITECTURE_SOURCE_REVISION_INVALID');
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
    id: `architecture-reconciliation:\${identity}`,
    packet: structuredClone(subject),
    postcondition: {
      verifier: 'operator-judgment/v1',
      subject,
    },
  };
}
