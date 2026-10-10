import { assertExactKeys, assertNonEmptyString, isData } from '../validation.ts';

export const SOURCE_INTEGRATION_EVIDENCE_SCHEMA =
  'overcenter-source-integration-evidence/v1' as const;

export interface SourceIntegrationEvidence {
  schema: typeof SOURCE_INTEGRATION_EVIDENCE_SCHEMA;
  run_id: string;
  obligation_key: string;
  source_sha: string;
  candidate_sha: string;
  verification_base_sha: string;
  verified_tree_sha: string;
  integration_commit: string;
  state: 'integrated' | 'already-integrated';
}

function exactSha(value: unknown, error: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error(error);
}

export function validateSourceIntegrationEvidence(value: unknown): SourceIntegrationEvidence {
  if (!isData(value)) throw new Error('SOURCE_INTEGRATION_EVIDENCE_INVALID');
  assertExactKeys(
    value,
    [
      'schema',
      'run_id',
      'obligation_key',
      'source_sha',
      'candidate_sha',
      'verification_base_sha',
      'verified_tree_sha',
      'integration_commit',
      'state',
    ],
    [],
    'SOURCE_INTEGRATION_EVIDENCE_INVALID',
  );
  if (value.schema !== SOURCE_INTEGRATION_EVIDENCE_SCHEMA) {
    throw new Error('SOURCE_INTEGRATION_EVIDENCE_SCHEMA_MISMATCH');
  }
  assertNonEmptyString(value.run_id, 'SOURCE_INTEGRATION_EVIDENCE_RUN_INVALID');
  assertNonEmptyString(value.obligation_key, 'SOURCE_INTEGRATION_EVIDENCE_KEY_INVALID');
  exactSha(value.source_sha, 'SOURCE_INTEGRATION_EVIDENCE_SOURCE_INVALID');
  exactSha(value.candidate_sha, 'SOURCE_INTEGRATION_EVIDENCE_CANDIDATE_INVALID');
  exactSha(value.verification_base_sha, 'SOURCE_INTEGRATION_EVIDENCE_BASE_INVALID');
  exactSha(value.verified_tree_sha, 'SOURCE_INTEGRATION_EVIDENCE_TREE_INVALID');
  exactSha(value.integration_commit, 'SOURCE_INTEGRATION_EVIDENCE_COMMIT_INVALID');
  if (value.state !== 'integrated' && value.state !== 'already-integrated') {
    throw new Error('SOURCE_INTEGRATION_EVIDENCE_STATE_INVALID');
  }
  return structuredClone(value) as unknown as SourceIntegrationEvidence;
}
