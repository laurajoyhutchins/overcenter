export const PROMOTION_SHADOW_SCHEMA = 'overcenter-promotion-shadow/v1' as const;

export interface CoordinateRelation {
  coordinate: string;
}

export interface PermitRelation extends CoordinateRelation {
  object_id: string;
  event_id: string;
}

export interface AssertRelation extends CoordinateRelation {
  event_id: string;
  proposition_id: string;
}

export interface SupportRelation extends CoordinateRelation {
  object_id: string;
  proposition_id: string;
}

export interface RequireRelation extends CoordinateRelation {
  proposition_id: string;
  required_proposition_id: string;
}

export interface PromotionShadowSnapshot {
  schema: typeof PROMOTION_SHADOW_SCHEMA;
  coordinate: string;
  objects: string[];
  events: string[];
  propositions: string[];
  permits: PermitRelation[];
  asserts: AssertRelation[];
  supports: SupportRelation[];
  requires: RequireRelation[];
  decision: {
    authority_object_id: string;
    evaluation_event_id: string;
    promotion_event_id: string;
    promotion_proposition_id: string;
    legacy_admitted: boolean;
  };
}

export interface PromotionShadowDecision {
  coordinate: string;
  admitted: boolean;
  legacy_admitted: boolean;
  agrees: boolean;
  exact_permit: boolean;
  required_propositions: string[];
  satisfied_requirements: string[];
  unsupported_requirements: string[];
  stale_relation_count: number;
  reasons: string[];
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`PROMOTION_SHADOW_INVALID:${label}`);
  }
}

function assertUnique(values: readonly string[], label: string): Set<string> {
  const seen = new Set<string>();
  for (const value of values) {
    assertNonEmpty(value, label);
    if (seen.has(value)) {
      throw new Error(`PROMOTION_SHADOW_INVALID:DUPLICATE_${label}:${value}`);
    }
    seen.add(value);
  }
  return seen;
}

function requirementClosure(snapshot: PromotionShadowSnapshot): string[] {
  const exact = snapshot.requires.filter((row) => row.coordinate === snapshot.coordinate);
  const outgoing = new Map<string, string[]>();
  for (const row of exact) {
    const values = outgoing.get(row.proposition_id) ?? [];
    values.push(row.required_proposition_id);
    outgoing.set(row.proposition_id, values);
  }

  const root = snapshot.decision.promotion_proposition_id;
  const visited = new Set<string>();
  const active = new Set<string>();
  const walk = (proposition: string): void => {
    if (active.has(proposition)) {
      throw new Error(`PROMOTION_SHADOW_INVALID:REQUIRES_CYCLE:${proposition}`);
    }
    if (visited.has(proposition)) return;
    active.add(proposition);
    for (const required of outgoing.get(proposition) ?? []) {
      walk(required);
      visited.add(required);
    }
    active.delete(proposition);
  };
  walk(root);
  return [...visited].sort();
}

export function evaluatePromotionShadow(
  snapshot: PromotionShadowSnapshot,
): PromotionShadowDecision {
  if (snapshot.schema !== PROMOTION_SHADOW_SCHEMA) {
    throw new Error('PROMOTION_SHADOW_INVALID:SCHEMA');
  }
  assertNonEmpty(snapshot.coordinate, 'COORDINATE');
  const objects = assertUnique(snapshot.objects, 'OBJECT');
  const events = assertUnique(snapshot.events, 'EVENT');
  const propositions = assertUnique(snapshot.propositions, 'PROPOSITION');

  const decision = snapshot.decision;
  if (!objects.has(decision.authority_object_id)) {
    throw new Error('PROMOTION_SHADOW_INVALID:AUTHORITY_OBJECT');
  }
  if (!events.has(decision.evaluation_event_id)) {
    throw new Error('PROMOTION_SHADOW_INVALID:EVALUATION_EVENT');
  }
  if (!events.has(decision.promotion_event_id)) {
    throw new Error('PROMOTION_SHADOW_INVALID:PROMOTION_EVENT');
  }
  if (!propositions.has(decision.promotion_proposition_id)) {
    throw new Error('PROMOTION_SHADOW_INVALID:PROMOTION_PROPOSITION');
  }
  if (typeof decision.legacy_admitted !== 'boolean') {
    throw new Error('PROMOTION_SHADOW_INVALID:LEGACY_DECISION');
  }

  for (const row of snapshot.permits) {
    if (!objects.has(row.object_id) || !events.has(row.event_id)) {
      throw new Error('PROMOTION_SHADOW_INVALID:PERMITS_REFERENCE');
    }
    assertNonEmpty(row.coordinate, 'PERMITS_COORDINATE');
  }
  for (const row of snapshot.asserts) {
    if (!events.has(row.event_id) || !propositions.has(row.proposition_id)) {
      throw new Error('PROMOTION_SHADOW_INVALID:ASSERTS_REFERENCE');
    }
    assertNonEmpty(row.coordinate, 'ASSERTS_COORDINATE');
  }
  for (const row of snapshot.supports) {
    if (!objects.has(row.object_id) || !propositions.has(row.proposition_id)) {
      throw new Error('PROMOTION_SHADOW_INVALID:SUPPORTS_REFERENCE');
    }
    assertNonEmpty(row.coordinate, 'SUPPORTS_COORDINATE');
  }
  for (const row of snapshot.requires) {
    if (!propositions.has(row.proposition_id) || !propositions.has(row.required_proposition_id)) {
      throw new Error('PROMOTION_SHADOW_INVALID:REQUIRES_REFERENCE');
    }
    if (row.proposition_id === row.required_proposition_id) {
      throw new Error('PROMOTION_SHADOW_INVALID:SELF_REQUIREMENT');
    }
    assertNonEmpty(row.coordinate, 'REQUIRES_COORDINATE');
  }

  const exactPermit = snapshot.permits.some(
    (row) =>
      row.coordinate === snapshot.coordinate &&
      row.object_id === decision.authority_object_id &&
      row.event_id === decision.promotion_event_id,
  );

  const required = requirementClosure(snapshot);
  const exactAsserted = new Set(
    snapshot.asserts
      .filter(
        (row) =>
          row.coordinate === snapshot.coordinate && row.event_id === decision.evaluation_event_id,
      )
      .map((row) => row.proposition_id),
  );
  const exactSupported = new Set(
    snapshot.supports
      .filter((row) => row.coordinate === snapshot.coordinate)
      .map((row) => row.proposition_id),
  );
  const satisfied = required.filter(
    (proposition) => exactAsserted.has(proposition) || exactSupported.has(proposition),
  );
  const unsupported = required.filter(
    (proposition) => !exactAsserted.has(proposition) && !exactSupported.has(proposition),
  );
  const staleRelationCount = [
    ...snapshot.permits,
    ...snapshot.asserts,
    ...snapshot.supports,
    ...snapshot.requires,
  ].filter((row) => row.coordinate !== snapshot.coordinate).length;

  const admitted = exactPermit && required.length > 0 && unsupported.length === 0;
  const reasons: string[] = [];
  if (!exactPermit) reasons.push('NO_EXACT_PERMIT');
  if (required.length === 0) reasons.push('NO_PROMOTION_REQUIREMENTS');
  reasons.push(...unsupported.map((proposition) => `UNSUPPORTED_REQUIREMENT:${proposition}`));
  if (admitted !== decision.legacy_admitted) reasons.push('LEGACY_DISAGREEMENT');

  return {
    coordinate: snapshot.coordinate,
    admitted,
    legacy_admitted: decision.legacy_admitted,
    agrees: admitted === decision.legacy_admitted,
    exact_permit: exactPermit,
    required_propositions: required,
    satisfied_requirements: satisfied,
    unsupported_requirements: unsupported,
    stale_relation_count: staleRelationCount,
    reasons,
  };
}
