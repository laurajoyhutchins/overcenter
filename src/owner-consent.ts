import { canonicalDigest } from './digest.ts';
import { hasExactKeys, isData } from './validation.ts';

/**
 * Non-authorizing presentation policy. It cannot grant an effect, accept source,
 * infer provider truth, or mint an owner approval. Only a separately authenticated
 * verifier may turn a real GitHub deployment review into an execution permission.
 */
export type MaterialEffect =
  | 'privilege-grant'
  | 'protection-policy-change'
  | 'production-cutover'
  | 'irreversible-data-change'
  | 'material-financial-commitment'
  | 'external-legal-commitment';

export interface ObservedConsentImpact {
  evidence: 'independently-verified' | 'unknown';
  effects: readonly MaterialEffect[];
  changed_paths: readonly string[];
  protected_paths: readonly string[];
  routine_policy?: {
    id: string;
    permitted_paths: readonly string[];
    independently_admitted: boolean;
  };
}

export type ConsentRouting =
  | { kind: 'routine-candidate'; reason: string }
  | { kind: 'owner-review'; reason: string }
  | { kind: 'hold'; reason: string };

const EFFECTS: ReadonlySet<string> = new Set<MaterialEffect>([
  'privilege-grant',
  'protection-policy-change',
  'production-cutover',
  'irreversible-data-change',
  'material-financial-commitment',
  'external-legal-commitment',
]);

function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.git')
  );
}

function canonicalPaths(paths: readonly string[]): boolean {
  return (
    Array.isArray(paths) &&
    paths.every((value) => typeof value === 'string' && validPath(value)) &&
    paths.every((value, index) => index === 0 || paths[index - 1]! < value)
  );
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** A classification proposal, never a capability or bypass of source admission. */
export function routeOwnerConsent(impact: ObservedConsentImpact): ConsentRouting {
  if (
    impact.evidence !== 'independently-verified' ||
    !canonicalPaths(impact.changed_paths) ||
    !canonicalPaths(impact.protected_paths) ||
    !Array.isArray(impact.effects) ||
    impact.effects.some((kind) => !EFFECTS.has(kind)) ||
    new Set(impact.effects).size !== impact.effects.length
  ) {
    return { kind: 'hold', reason: 'Impact evidence is unknown or malformed.' };
  }
  if (impact.effects.length > 0) {
    return { kind: 'owner-review', reason: 'The observed operation has a consequential effect.' };
  }
  if (impact.changed_paths.length === 0) {
    return { kind: 'hold', reason: 'There is no observed work to admit.' };
  }
  const protectedChanges = impact.changed_paths.filter((path) =>
    impact.protected_paths.some((root) => within(root, path)),
  );
  if (protectedChanges.length !== 0) {
    const policy = impact.routine_policy;
    if (
      !policy ||
      !policy.independently_admitted ||
      !policy.id ||
      !canonicalPaths(policy.permitted_paths) ||
      protectedChanges.some((path) => !policy.permitted_paths.includes(path))
    ) {
      return {
        kind: 'hold',
        reason:
          'Protected maintenance requires an independently admitted narrow policy, not routine owner approval.',
      };
    }
  }
  return {
    kind: 'routine-candidate',
    reason: 'No consequential effect was observed; existing admission gates still apply.',
  };
}

export const OWNER_CONSENT_SCHEMA = 'overcenter-owner-consent-request/v1' as const;

export interface OwnerConsentRequest {
  schema: typeof OWNER_CONSENT_SCHEMA;
  request_id: string;
  repository: string;
  base_sha: string;
  candidate_sha: string;
  candidate_tree_sha: string;
  expires_at: string;
  operation: MaterialEffect;
  outcome: string;
  why: string;
  scope: string;
  risks: string;
  approval_consequence: string;
  rejection_consequence: string;
  recovery: string;
  verification: string;
  evidence_url: string;
}

const REQUEST_KEYS = [
  'schema',
  'request_id',
  'repository',
  'base_sha',
  'candidate_sha',
  'candidate_tree_sha',
  'expires_at',
  'operation',
  'outcome',
  'why',
  'scope',
  'risks',
  'approval_consequence',
  'rejection_consequence',
  'recovery',
  'verification',
  'evidence_url',
] as const;

function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function requestValid(value: unknown): value is OwnerConsentRequest {
  if (!isData(value) || !hasExactKeys(value, REQUEST_KEYS)) return false;
  if (Object.values(value).some((field) => typeof field !== 'string')) return false;
  const request = value as unknown as OwnerConsentRequest;
  if (
    request.schema !== OWNER_CONSENT_SCHEMA ||
    !EFFECTS.has(request.operation) ||
    !/^[A-Za-z0-9._-]{1,120}$/.test(request.request_id) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository) ||
    !isSha(request.base_sha) ||
    !isSha(request.candidate_sha) ||
    !isSha(request.candidate_tree_sha) ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(request.evidence_url)
  )
    return false;
  const expires = Date.parse(request.expires_at);
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== request.expires_at)
    return false;
  for (const key of [
    'outcome',
    'why',
    'scope',
    'risks',
    'approval_consequence',
    'rejection_consequence',
    'recovery',
    'verification',
  ] as const) {
    const text = request[key];
    if (text.trim().length === 0 || text.length > 500 || /[\r\n]/.test(text)) return false;
  }
  return true;
}

export function ownerConsentRequestDigest(value: unknown): string {
  if (!requestValid(value)) throw new Error('OWNER_CONSENT_REQUEST_INVALID');
  return canonicalDigest({ domain: OWNER_CONSENT_SCHEMA, request: value });
}

/** Concise review text derived entirely from the exact digested request. */
export function ownerConsentSummary(value: unknown): string {
  if (!requestValid(value)) throw new Error('OWNER_CONSENT_REQUEST_INVALID');
  const digest = ownerConsentRequestDigest(value);
  return [
    `Decision: ${value.outcome}`,
    `Why: ${value.why}`,
    `Scope: ${value.scope}`,
    `Risk: ${value.risks}`,
    `Approve: ${value.approval_consequence}`,
    `Reject: ${value.rejection_consequence}`,
    `Recovery: ${value.recovery}`,
    `Verification: ${value.verification}`,
    `Evidence: ${value.evidence_url}`,
    `Exact candidate: ${value.candidate_sha}`,
    `Expires: ${value.expires_at}`,
    `Request digest: ${digest}`,
  ].join('\n');
}
