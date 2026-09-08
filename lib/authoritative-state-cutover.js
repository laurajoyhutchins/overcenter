import { canonicalJson, sha256Text } from './canonical-json.js';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

const SOURCE_LOCK_TABLES = Object.freeze([
  '__hatchable_migrations',
  'execution_state',
  'github_changeset_receipts',
  'github_production_promotion_receipts',
  'github_release_receipts',
  'github_required_check_observations',
  'operation_state',
  'orchestration_command_invocations',
  'orchestration_horizons',
  'orchestration_invocation_resolutions',
  'orchestration_runs',
  'orchestration_skill_activations',
  'portfolio_reconcile_receipts',
  'portfolio_repository_branch_roles',
  'portfolio_repository_disposition',
  'portfolio_verification_receipts',
  'portfolio_work_identity',
  'proof_state',
  'scheduled_cycle_events',
  'work_lease_checkpoints',
  'work_lease_heartbeats',
  'work_lease_slots',
  'work_leases',
]);

function failure(code, message, details = {}, status = 409) {
  return Object.assign(new Error(message), { code, details, status, mayHaveMutated:false });
}

function text(value) {
  return value == null ? null : String(value);
}

function count(value) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) throw failure('CUTOVER_COORDINATE_INVALID', 'cutover count coordinate is invalid', { value });
  return number;
}

function normalizeCoordinate(value) {
  return value == null || value === '' ? null : String(value);
}

function projectRepository(projectRef, repositoryInput) {
  const project = String(projectRef || '').trim();
  const repository = String(repositoryInput || '').trim() || (project.startsWith('github:') ? project.slice('github:'.length) : '');
  if (!/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || project !== `github:${repository}`) {
    throw failure('CUTOVER_PROJECT_INVALID', 'exact matching GitHub project and repository are required', { project_ref:project || null, repository:repository || null }, 422);
  }
  return { projectRef:project, repository };
}

function transitionConfirmation(row, index) {
  const transitionId = String(row?.transition_id || '').trim();
  const fingerprint = String(row?.transition_definition_fingerprint || '').trim().toLowerCase();
  const revision = String(row?.source_authority_revision || '').trim().toLowerCase();
  const settledAt = String(row?.settled_at || '').trim();
  if (!transitionId || !/^[0-9a-f]{64}$/.test(fingerprint) || !SHA40.test(revision) || !Number.isFinite(Date.parse(settledAt))) {
    throw failure('CUTOVER_RECOVERY_SEED_INVALID', 'completed transition cannot be represented in GitHub recovery seed', { index, transition_id:transitionId || null });
  }
  return Object.freeze({
    transition_id:transitionId,
    transition_definition_fingerprint:fingerprint,
    source_authority_revision:revision,
    settled_at:settledAt,
  });
}

function branchRole(row) {
  return Object.freeze({
    repository:String(row.repository || '').trim(),
    development_branch:String(row.development_branch || '').trim(),
    production_branch:String(row.production_branch || '').trim(),
    production_source_ref:String(row.production_source_ref || '').trim(),
  });
}

function repositoryDisposition(row) {
  return Object.freeze({
    repository:String(row.repository || '').trim(),
    disposition:String(row.disposition || '').trim(),
    compatibility_bound:Boolean(row.compatibility_bound),
    successor_repository:text(row.successor_repository),
    github_archived:row.github_archived == null ? null : Boolean(row.github_archived),
    transition_reason:text(row.transition_reason),
    compatibility_reference:text(row.compatibility_reference),
    github_repository_id:text(row.github_repository_id),
  });
}

export async function captureGitHubRecoverySeed({ db, project_ref, repository:repositoryInput } = {}) {
  if (!db || typeof db.query !== 'function') throw failure('CUTOVER_DB_REQUIRED', 'database provider is required', {}, 500);
  const { projectRef, repository } = projectRepository(project_ref, repositoryInput);
  const [transitionResult, branchRoleResult, dispositionResult] = await Promise.all([
    db.query(
      `SELECT settle_receipt->'project_transition'->>'transition_id' AS transition_id,
              settle_receipt->'project_transition'->>'transition_definition_fingerprint' AS transition_definition_fingerprint,
              settle_receipt->'project_transition'->>'authority_revision' AS source_authority_revision,
              settled_at
         FROM work_leases
        WHERE status='settled'
          AND claim_receipt->>'subject'='project_transition'
          AND settle_receipt->>'subject'='project_transition'
          AND settle_receipt->>'disposition'='completed'
          AND settle_receipt->'project_transition'->>'project_ref'=$1
        ORDER BY transition_id, settled_at`,
      [projectRef],
    ),
    db.query(
      `SELECT repository, development_branch, production_branch, production_source_ref, updated_at
         FROM portfolio_repository_branch_roles
        ORDER BY lower(repository)`,
    ),
    db.query(
      `SELECT repository, disposition, compatibility_bound, successor_repository, github_archived,
              transition_reason, compatibility_reference, github_repository_id, updated_at
         FROM portfolio_repository_disposition
        ORDER BY lower(repository)`,
    ),
  ]);

  const transitionRows = transitionResult?.rows || [];
  const roleRows = branchRoleResult?.rows || [];
  const dispositionRows = dispositionResult?.rows || [];
  const transitionConfirmations = transitionRows.map(transitionConfirmation);
  const repositoryBranchRoles = roleRows.map(branchRole);
  const repositoryDispositions = dispositionRows.map(repositoryDisposition);
  const coordinates = Object.freeze({
    transition_confirmations_count:transitionRows.length,
    transition_confirmations_max_settled_at:transitionRows.reduce((latest, row) => !latest || Date.parse(String(row.settled_at)) > Date.parse(latest) ? String(row.settled_at) : latest, null),
    branch_roles_count:roleRows.length,
    branch_roles_max_updated_at:roleRows.reduce((latest, row) => !latest || String(row.updated_at) > latest ? String(row.updated_at) : latest, null),
    repository_dispositions_count:dispositionRows.length,
    repository_dispositions_max_updated_at:dispositionRows.reduce((latest, row) => !latest || String(row.updated_at) > latest ? String(row.updated_at) : latest, null),
  });
  const body = {
    schema:'overcenter-github-recovery-seed-v1',
    project_ref:projectRef,
    repository,
    transition_confirmations:transitionConfirmations,
    repository_branch_roles:repositoryBranchRoles,
    repository_dispositions:repositoryDispositions,
    source_coordinates:coordinates,
  };
  const digest = `sha256:${await sha256Text(canonicalJson(body))}`;
  return Object.freeze({ seed:Object.freeze({ ...body, digest }), coordinates, digest });
}

const FREEZE_SQL = `UPDATE overcenter_authority_freeze
   SET frozen=true,
       frozen_at=now(),
       source_revision=$1,
       freeze_manifest_sha256=$2
 WHERE singleton=true
   AND frozen=false
   AND (SELECT count(*)::bigint
          FROM work_leases
         WHERE status='settled'
           AND claim_receipt->>'subject'='project_transition'
           AND settle_receipt->>'subject'='project_transition'
           AND settle_receipt->>'disposition'='completed'
           AND settle_receipt->'project_transition'->>'project_ref'=$3) = $4::bigint
   AND (SELECT max(settled_at)
          FROM work_leases
         WHERE status='settled'
           AND claim_receipt->>'subject'='project_transition'
           AND settle_receipt->>'subject'='project_transition'
           AND settle_receipt->>'disposition'='completed'
           AND settle_receipt->'project_transition'->>'project_ref'=$3) IS NOT DISTINCT FROM $5::timestamptz
   AND (SELECT count(*)::bigint FROM portfolio_repository_branch_roles) = $6::bigint
   AND (SELECT max(updated_at) FROM portfolio_repository_branch_roles) IS NOT DISTINCT FROM $7::timestamptz
   AND (SELECT count(*)::bigint FROM portfolio_repository_disposition) = $8::bigint
   AND (SELECT max(updated_at) FROM portfolio_repository_disposition) IS NOT DISTINCT FROM $9::timestamptz
 RETURNING frozen, frozen_at, source_revision, freeze_manifest_sha256`;

export async function freezeSourceAtRecoveryCoordinates({ db, project_ref, source_revision, seed_digest, coordinates } = {}) {
  if (!db || typeof db.transaction !== 'function') throw failure('CUTOVER_TRANSACTION_PROVIDER_REQUIRED', 'atomic database transaction provider is required', {}, 500);
  const { projectRef } = projectRepository(project_ref);
  const revision = String(source_revision || '').trim().toLowerCase();
  const digest = String(seed_digest || '').trim().toLowerCase();
  if (!SHA40.test(revision)) throw failure('CUTOVER_REVISION_INVALID', 'source_revision must be an exact Git SHA', {}, 422);
  if (!SHA256.test(digest)) throw failure('CUTOVER_SEED_DIGEST_INVALID', 'seed_digest must be sha256:<64 hex>', {}, 422);
  const c = coordinates || {};
  const params = [
    revision,
    digest,
    projectRef,
    count(c.transition_confirmations_count),
    normalizeCoordinate(c.transition_confirmations_max_settled_at),
    count(c.branch_roles_count),
    normalizeCoordinate(c.branch_roles_max_updated_at),
    count(c.repository_dispositions_count),
    normalizeCoordinate(c.repository_dispositions_max_updated_at),
  ];
  const lockSql = `LOCK TABLE ${SOURCE_LOCK_TABLES.join(', ')} IN ACCESS EXCLUSIVE MODE`;
  const transaction = await db.transaction([
    { sql:lockSql, params:[] },
    { sql:FREEZE_SQL, params },
  ]);
  const row = transaction?.results?.[1]?.rows?.[0] || null;
  if (!row) {
    throw failure('CUTOVER_FREEZE_PRECONDITION_MISMATCH', 'source durable coordinates changed before freeze; capture and commit a fresh GitHub recovery seed');
  }
  return Object.freeze({
    schema:'overcenter-source-freeze-v1',
    frozen:row.frozen === true,
    frozen_at:String(row.frozen_at || ''),
    source_revision:String(row.source_revision || '').toLowerCase(),
    seed_digest:String(row.freeze_manifest_sha256 || '').toLowerCase(),
    source_coordinates:Object.freeze({ ...c }),
    locked_tables:SOURCE_LOCK_TABLES.length,
  });
}

export { SOURCE_LOCK_TABLES };
