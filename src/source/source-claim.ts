import { assertNonEmptyString } from '../validation.ts';

export interface SourceClaimBinding {
  obligation_key: string;
  run_id: string;
  claimed_revision: string;
  source_sha: string;
}

export function bindSourceClaim(
  obligationKey: string,
  runId: string,
  claimedRevision: string,
  sourceSha: string,
): SourceClaimBinding {
  assertNonEmptyString(obligationKey, 'SOURCE_CLAIM_OBLIGATION_KEY_INVALID');
  assertNonEmptyString(runId, 'SOURCE_CLAIM_RUN_ID_INVALID');
  assertNonEmptyString(claimedRevision, 'SOURCE_CLAIM_REVISION_INVALID');
  if (typeof sourceSha !== 'string' || !/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error('SOURCE_CLAIM_SOURCE_SHA_INVALID');
  }
  return {
    obligation_key: obligationKey,
    run_id: runId,
    claimed_revision: claimedRevision,
    source_sha: sourceSha,
  };
}
