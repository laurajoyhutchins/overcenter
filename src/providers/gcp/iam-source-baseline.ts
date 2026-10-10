/**
 * Strict direct-policy IAM inventory. Source/readback preparation only:
 * no effective-permission conclusion, privilege grant, or effect admission.
 */
export type GcpIamPolicyReadback =
  | { readonly state: 'observed'; readonly resource: string; readonly policy: unknown; readonly evidence_ref: string }
  | { readonly state: 'indeterminate'; readonly resource: string; readonly reason: string };

export interface GcpIamDirectBinding {
  readonly resource: string;
  readonly role: string;
  readonly member: string;
  readonly condition_expression: string | null;
}

export type GcpIamSourceBaseline =
  | {
      readonly state: 'hold';
      readonly reasons: readonly string[];
      readonly directly_observed_bindings: readonly GcpIamDirectBinding[];
      readonly authorization_established: false;
      readonly effective_permissions_established: false;
    }
  | {
      readonly state: 'observed';
      readonly scope: 'direct-bindings-only';
      readonly evidence_refs: readonly string[];
      readonly directly_observed_bindings: readonly GcpIamDirectBinding[];
      readonly authorization_established: false;
      readonly effective_permissions_established: false;
    };

const resourcePattern = /^[a-z][a-z0-9-]*(?:\/[a-zA-Z0-9_.@-]+)+$/;
const rolePattern =
  /^(?:roles\/[a-zA-Z][a-zA-Z0-9_.]*|(?:projects|organizations)\/[a-zA-Z0-9_-]+\/roles\/[a-zA-Z][a-zA-Z0-9_.]*)$/;
const memberPattern = /^(?:(?:user|group|serviceAccount|domain|principal|principalSet):[^\s]+|allUsers|allAuthenticatedUsers)$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface ParsedBinding {
  role: string;
  members: readonly string[];
  conditionExpression: string | null;
}

function parsePolicy(value: unknown): readonly ParsedBinding[] {
  if (!record(value)) throw new Error('POLICY_NOT_OBJECT');
  if (typeof value.etag !== 'string' || value.etag.length === 0) {
    throw new Error('POLICY_ETAG_REQUIRED');
  }
  // Require version 3 readbacks to avoid accidentally dropping conditions.
  if (value.version !== 3) throw new Error('POLICY_VERSION_3_REQUIRED');
  if (!Array.isArray(value.bindings)) throw new Error('POLICY_BINDINGS_REQUIRED');
  const normalized: ParsedBinding[] = [];
  for (const entry of value.bindings as unknown[]) {
    if (!record(entry) || typeof entry.role !== 'string' || !rolePattern.test(entry.role)) {
      throw new Error('INVALID_ROLE');
    }
    if (!Array.isArray(entry.members) || entry.members.length === 0) {
      throw new Error('INVALID_MEMBERS');
    }
    const members: string[] = [];
    for (const member of entry.members as unknown[]) {
      if (typeof member !== 'string' || !memberPattern.test(member)) {
        throw new Error('INVALID_MEMBER');
      }
      members.push(member);
    }
    let conditionExpression: string | null = null;
    if (entry.condition !== undefined) {
      if (
        !record(entry.condition) ||
        typeof entry.condition.expression !== 'string' ||
        entry.condition.expression.length === 0 ||
        typeof entry.condition.title !== 'string' ||
        entry.condition.title.length === 0
      ) {
        throw new Error('INVALID_CONDITION');
      }
      conditionExpression = entry.condition.expression;
    }
    normalized.push({ role: entry.role, members, conditionExpression });
  }
  return normalized;
}

/**
 * Reports only bindings for caller-declared exact resources. Even 'observed'
 * does not prove effective permissions: inherited roles, WIF, Deny, PAB and
 * custom-role definitions are not evaluated by this function.
 */
export function inspectGcpIamDirectBindings(
  requiredResources: readonly string[],
  readbacks: readonly GcpIamPolicyReadback[],
): GcpIamSourceBaseline {
  if (
    requiredResources.length === 0 ||
    requiredResources.some((resource) => !resourcePattern.test(resource)) ||
    new Set(requiredResources).size !== requiredResources.length
  ) {
    throw new Error('REQUIRED_RESOURCES_INVALID');
  }
  const required = new Set(requiredResources);
  const seen = new Set<string>();
  const reasons: string[] = [];
  const evidenceRefs: string[] = [];
  const bindings: GcpIamDirectBinding[] = [];
  for (const readback of readbacks) {
    if (!required.has(readback.resource) || seen.has(readback.resource)) {
      throw new Error('UNEXPECTED_OR_DUPLICATE_IAM_READBACK');
    }
    seen.add(readback.resource);
    if (readback.state === 'indeterminate') {
      reasons.push(readback.resource + ': ' + (readback.reason || 'INDETERMINATE'));
      continue;
    }
    if (
      typeof readback.evidence_ref !== 'string' ||
      !/^[a-zA-Z0-9_./:#-]+$/.test(readback.evidence_ref)
    ) {
      reasons.push(readback.resource + ': EVIDENCE_REF_REQUIRED');
      continue;
    }
    try {
      for (const binding of parsePolicy(readback.policy)) {
        for (const member of binding.members) {
          bindings.push({
            resource: readback.resource,
            role: binding.role,
            member,
            condition_expression: binding.conditionExpression,
          });
        }
      }
      evidenceRefs.push(readback.evidence_ref);
    } catch (error) {
      reasons.push(
        readback.resource + ': ' + (error instanceof Error ? error.message : 'INVALID_POLICY'),
      );
    }
  }
  for (const resource of requiredResources) {
    if (!seen.has(resource)) reasons.push(resource + ': MISSING_READBACK');
  }
  const sorted = bindings.sort((a, b) =>
    [a.resource, a.role, a.member, a.condition_expression ?? ''].join('|').localeCompare(
      [b.resource, b.role, b.member, b.condition_expression ?? ''].join('|'),
    ),
  );
  if (reasons.length > 0) {
    return {
      state: 'hold',
      reasons: reasons.sort(),
      directly_observed_bindings: sorted,
      authorization_established: false,
      effective_permissions_established: false,
    };
  }
  return {
    state: 'observed',
    scope: 'direct-bindings-only',
    evidence_refs: evidenceRefs.sort(),
    directly_observed_bindings: sorted,
    authorization_established: false,
    effective_permissions_established: false,
  };
}
