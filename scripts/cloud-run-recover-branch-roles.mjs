import pg from 'pg';
import { readFile } from 'node:fs/promises';

import { canonicalJson, sha256Text } from '../lib/canonical-json.js';
import { normalizeRepositoryBranchRoleBinding } from '../lib/repository-branch-roles.js';
import { resolveCloudRunConfig } from './cloud-run-host.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SEED_URL = new URL('../.overcenter/recovery/hatchable-cutover-v1.json', import.meta.url);

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), {
    code,
    details:{ ...details, may_have_mutated:false },
    may_have_mutated:false,
  });
}

async function readVerifiedSeed(expectedDigest) {
  const expected = String(expectedDigest || '').trim().toLowerCase();
  if (!SHA256.test(expected)) fail('BRANCH_ROLE_RECOVERY_DIGEST_REQUIRED', 'sealed source-freeze digest is required');
  const seed = JSON.parse(await readFile(SEED_URL, 'utf8'));
  if (seed?.schema !== 'overcenter-github-recovery-seed-v1') fail('BRANCH_ROLE_RECOVERY_SEED_INVALID', 'sealed recovery seed is invalid');
  const claimed = String(seed.digest || '').trim().toLowerCase();
  const body = { ...seed };
  delete body.digest;
  const computed = `sha256:${await sha256Text(canonicalJson(body))}`;
  if (claimed !== expected || computed !== expected) {
    fail('BRANCH_ROLE_RECOVERY_SEED_MISMATCH', 'sealed recovery seed does not match the source-freeze digest', { expected_digest:expected, claimed_digest:claimed, computed_digest:computed });
  }
  const roles = Array.isArray(seed.repository_branch_roles)
    ? seed.repository_branch_roles.map(normalizeRepositoryBranchRoleBinding)
    : [];
  if (roles.length !== Number(seed?.source_coordinates?.branch_roles_count)) {
    fail('BRANCH_ROLE_RECOVERY_COUNT_MISMATCH', 'sealed branch-role count does not match source coordinates');
  }
  return { digest:expected, roles };
}

function same(left, right) {
  return left
    && String(left.repository).toLowerCase() === String(right.repository).toLowerCase()
    && left.development_branch === right.development_branch
    && left.production_branch === right.production_branch
    && left.production_source_ref === right.production_source_ref;
}

export async function recoverBranchRoles({ db, expectedDigest } = {}) {
  if (!db || typeof db.connect !== 'function') fail('BRANCH_ROLE_RECOVERY_DATABASE_REQUIRED', 'PostgreSQL pool is required');
  const seed = await readVerifiedSeed(expectedDigest);
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const existing = await client.query(
      `SELECT repository, development_branch, production_branch, production_source_ref
         FROM portfolio_repository_branch_roles
        ORDER BY lower(repository)`,
    );
    const byRepo = new Map((existing.rows || []).map(row => [String(row.repository).toLowerCase(), row]));
    for (const binding of seed.roles) {
      const current = byRepo.get(binding.repository.toLowerCase());
      if (current && !same(current, binding)) {
        fail('BRANCH_ROLE_RECOVERY_CONFLICT', 'target branch-role binding conflicts with sealed source state', { repository:binding.repository, existing:current, expected:binding });
      }
    }
    let inserted = 0;
    for (const binding of seed.roles) {
      if (byRepo.has(binding.repository.toLowerCase())) continue;
      const result = await client.query(
        `INSERT INTO portfolio_repository_branch_roles
           (repository, development_branch, production_branch, production_source_ref, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (repository) DO NOTHING
         RETURNING repository`,
        [binding.repository, binding.development_branch, binding.production_branch, binding.production_source_ref],
      );
      if (result.rows?.length !== 1) fail('BRANCH_ROLE_RECOVERY_RACE', 'branch-role row changed concurrently during recovery', { repository:binding.repository });
      inserted += 1;
    }
    const readback = await client.query(
      `SELECT repository, development_branch, production_branch, production_source_ref
         FROM portfolio_repository_branch_roles
        ORDER BY lower(repository)`,
    );
    for (const binding of seed.roles) {
      const row = (readback.rows || []).find(candidate => String(candidate.repository).toLowerCase() === binding.repository.toLowerCase());
      if (!same(row, binding)) fail('BRANCH_ROLE_RECOVERY_READBACK_MISMATCH', 'recovered branch-role readback does not match sealed source state', { repository:binding.repository });
    }
    await client.query('COMMIT');
    return { ok:true, digest:seed.digest, expected_count:seed.roles.length, inserted_count:inserted, bindings:seed.roles };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let pool;
  try {
    const config = resolveCloudRunConfig(process.env);
    if (config.authorityMode !== 'authoritative') fail('BRANCH_ROLE_RECOVERY_AUTHORITY_MODE_INVALID', 'recovery requires authoritative GCP mode');
    pool = new pg.Pool(config.postgres);
    const result = await recoverBranchRoles({ db:pool, expectedDigest:process.env.OVERCENTER_SOURCE_FREEZE_DIGEST });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ ok:false, error:error?.code || 'BRANCH_ROLE_RECOVERY_FAILED', message:error?.message || 'branch-role recovery failed', details:error?.details || null, may_have_mutated:error?.may_have_mutated === true }));
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}
