/**
 * Deterministic preflight for source PR integration.
 *
 * This is a diagnostic projection over externally observed facts, NOT an
 * admission token, merge authorization, or substitute for protected-source
 * verification. A caller must independently bind GitHub API observations,
 * certification receipts, owner approval, and the exact target ref before any
 * effect. In particular, READY_TO_REQUEST_ADMISSION never permits a git push.
 */
export type CandidateCheck = Readonly<{
  name: string;
  head_sha: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
}>;

export type CandidateReadinessSnapshot = Readonly<{
  repository: string;
  pull_number: number;
  expected_head_sha: string;
  expected_base_sha: string;
  observed_head_sha: string;
  observed_base_sha: string;
  mergeability: 'clean' | 'dirty' | 'behind' | 'unstable' | 'unknown';
  draft: boolean;
  protected_paths_modified: boolean;
  required_check_names: readonly string[];
  checks: readonly CandidateCheck[];
}>;

export type CandidateReadinessDecision =
  | 'REJECT_INVALID'
  | 'REREALIZE_HEAD'
  | 'REREALIZE_BASE'
  | 'REPAIR_CONFLICT'
  | 'AWAIT_MERGEABILITY'
  | 'AWAIT_DRAFT_PROMOTION'
  | 'REJECT_DUPLICATE_EVIDENCE'
  | 'REJECT_CHECK_IDENTITY'
  | 'REJECT_CHECK_FAILURE'
  | 'AWAIT_CHECKS'
  | 'AWAIT_PROTECTED_SOURCE_REVIEW'
  | 'READY_TO_REQUEST_ADMISSION';

export type CandidateReadinessResult = Readonly<{
  decision: CandidateReadinessDecision;
  reason: string;
  candidate_sha: string;
  base_sha: string;
  /** A readiness plan never confers mutation authority. */
  effect_authorized: false;
}>;

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function assessCandidateReadiness(
  snapshot: CandidateReadinessSnapshot,
): CandidateReadinessResult {
  const outcome = (decision: CandidateReadinessDecision, reason: string): CandidateReadinessResult => ({
    decision,
    reason,
    candidate_sha: snapshot.expected_head_sha,
    base_sha: snapshot.expected_base_sha,
    effect_authorized: false,
  });

  if (
    !REPOSITORY.test(snapshot.repository) ||
    !Number.isSafeInteger(snapshot.pull_number) ||
    snapshot.pull_number <= 0 ||
    !SHA.test(snapshot.expected_head_sha) ||
    !SHA.test(snapshot.expected_base_sha) ||
    !SHA.test(snapshot.observed_head_sha) ||
    !SHA.test(snapshot.observed_base_sha) ||
    !Array.isArray(snapshot.required_check_names) ||
    snapshot.required_check_names.length === 0 ||
    snapshot.required_check_names.some((name) => typeof name !== 'string' || !name.trim()) ||
    typeof snapshot.draft !== 'boolean' ||
    typeof snapshot.protected_paths_modified !== 'boolean' ||
    !Array.isArray(snapshot.checks)
  ) {
    return outcome('REJECT_INVALID', 'INVALID_CANDIDATE_READINESS_SNAPSHOT');
  }
  if (snapshot.observed_head_sha !== snapshot.expected_head_sha) {
    return outcome('REREALIZE_HEAD', 'CANDIDATE_HEAD_MOVED');
  }
  if (snapshot.observed_base_sha !== snapshot.expected_base_sha) {
    return outcome('REREALIZE_BASE', 'TARGET_BASE_MOVED');
  }
  if (snapshot.mergeability === 'dirty') {
    return outcome('REPAIR_CONFLICT', 'SOURCE_MERGE_CONFLICT');
  }
  if (snapshot.mergeability === 'behind') {
    return outcome('REREALIZE_BASE', 'CANDIDATE_BEHIND_TARGET');
  }
  if (snapshot.mergeability !== 'clean') {
    return outcome('AWAIT_MERGEABILITY', 'MERGEABILITY_NOT_ESTABLISHED');
  }
  if (snapshot.draft) {
    return outcome('AWAIT_DRAFT_PROMOTION', 'CANDIDATE_STILL_DRAFT');
  }

  const required = new Set(snapshot.required_check_names);
  if (required.size !== snapshot.required_check_names.length) {
    return outcome('REJECT_INVALID', 'DUPLICATE_REQUIRED_CHECK_NAME');
  }
  const seen = new Map<string, CandidateCheck>();
  for (const check of snapshot.checks) {
    if (
      !check ||
      typeof check.name !== 'string' ||
      !check.name.trim() ||
      !SHA.test(check.head_sha) ||
      !['queued', 'in_progress', 'completed'].includes(check.status) ||
      (check.conclusion !== null && typeof check.conclusion !== 'string')
    ) {
      return outcome('REJECT_INVALID', 'INVALID_CHECK_OBSERVATION');
    }
    if (!required.has(check.name)) continue;
    if (seen.has(check.name)) {
      return outcome('REJECT_DUPLICATE_EVIDENCE', 'DUPLICATE_REQUIRED_CHECK_CONTEXT');
    }
    seen.set(check.name, check);
    if (check.head_sha !== snapshot.expected_head_sha) {
      return outcome('REJECT_CHECK_IDENTITY', 'CHECK_HEAD_SHA_MISMATCH');
    }
    if (check.status === 'completed' && check.conclusion !== 'success') {
      return outcome('REJECT_CHECK_FAILURE', 'REQUIRED_CHECK_DID_NOT_SUCCEED');
    }
  }
  if (
    [...required].some((name) => {
      const check = seen.get(name);
      return !check || check.status !== 'completed' || check.conclusion !== 'success';
    })
  ) {
    return outcome('AWAIT_CHECKS', 'REQUIRED_EXACT_HEAD_CHECKS_INCOMPLETE');
  }
  if (snapshot.protected_paths_modified) {
    return outcome('AWAIT_PROTECTED_SOURCE_REVIEW', 'INDEPENDENT_PROTECTED_SOURCE_ADMISSION_REQUIRED');
  }
  return outcome('READY_TO_REQUEST_ADMISSION', 'ALL_OBSERVED_CHECKS_PASSED_REQUIRE_EXTERNAL_ADMISSION');
}
