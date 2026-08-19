import { db } from 'hatchable';
import { canonicalJson, sha256Text } from 'lib/canonical-json.js';

const OWNER = 'laurajoyhutchins';
const APPROVAL_TTL_MS = 30 * 60 * 1000;

function iso(value) { return new Date(value).toISOString(); }
function approvalPath(id) { return `/github-repository-approvals?approval_id=${encodeURIComponent(String(id))}`; }

export async function repositoryCreationRequestSha(normalized) {
  return sha256Text(canonicalJson({
    owner: OWNER,
    name: normalized.name,
    repo: normalized.repo,
    description: normalized.description ?? null,
    private: true,
    auto_init: false,
  }));
}

export function createPostgresRepositoryCreationApprovalStore(dbBinding = db, options = {}) {
  const now = options.now || (() => Date.now());
  const ttlMs = Number(options.ttlMs || APPROVAL_TTL_MS);
  return {
    async ensure(normalized) {
      const requestSha = await repositoryCreationRequestSha(normalized);
      const currentIso = iso(now());
      const active = await dbBinding.query(
        `SELECT approval_id, request_sha256, repo, name, description, state, requested_at, expires_at, decided_at, consumed_at
           FROM github_repository_creation_approvals
          WHERE request_sha256 = $1
            AND state IN ('pending','approved')
            AND expires_at > $2::timestamptz
          ORDER BY requested_at DESC
          LIMIT 1`,
        [requestSha, currentIso],
      );
      const row = active.rows?.[0] || null;
      if (row) {
        return {
          approved: row.state === 'approved',
          state: row.state,
          approval_id: row.approval_id,
          repo: row.repo,
          expires_at: row.expires_at,
          approval_path: approvalPath(row.approval_id),
          request_sha256: row.request_sha256,
        };
      }
      const expiresAt = iso(Number(now()) + ttlMs);
      const inserted = await dbBinding.query(
        `INSERT INTO github_repository_creation_approvals
           (request_sha256, repo, name, description, state, expires_at)
         VALUES ($1,$2,$3,$4,'pending',$5::timestamptz)
         RETURNING approval_id, request_sha256, repo, state, requested_at, expires_at`,
        [requestSha, normalized.repo, normalized.name, normalized.description ?? null, expiresAt],
      );
      const created = inserted.rows?.[0];
      return {
        approved: false,
        state: 'pending',
        approval_id: created.approval_id,
        repo: created.repo,
        expires_at: created.expires_at,
        approval_path: approvalPath(created.approval_id),
        request_sha256: created.request_sha256,
      };
    },

    async consume(approvalId, requestSha) {
      const result = await dbBinding.query(
        `UPDATE github_repository_creation_approvals
            SET state = 'consumed', consumed_at = now()
          WHERE approval_id = $1
            AND request_sha256 = $2
            AND state = 'approved'
          RETURNING approval_id, state, consumed_at`,
        [approvalId, requestSha],
      );
      return result.rows?.[0] || null;
    },
  };
}

export async function ensureRepositoryCreationApproval(normalized, options = {}) {
  const store = options.store || createPostgresRepositoryCreationApprovalStore(options.db || db, options);
  return store.ensure(normalized);
}

export async function consumeRepositoryCreationApproval(approval, options = {}) {
  if (!approval?.approval_id || !approval?.request_sha256) return null;
  const store = options.store || createPostgresRepositoryCreationApprovalStore(options.db || db, options);
  return store.consume(approval.approval_id, approval.request_sha256);
}

export async function listRepositoryCreationApprovals(dbBinding = db) {
  const result = await dbBinding.query(
    `SELECT approval_id, repo, name, description, state, requested_at, expires_at, decided_at, consumed_at
       FROM github_repository_creation_approvals
      WHERE state IN ('pending','approved') AND expires_at > now()
      ORDER BY requested_at DESC
      LIMIT 50`,
    [],
  );
  return result.rows || [];
}

export async function decideRepositoryCreationApproval(approvalId, decision, dbBinding = db) {
  const id = String(approvalId || '').trim();
  const action = String(decision || '').trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: 'INVALID_APPROVAL_ID' };
  if (!['approve','reject'].includes(action)) return { ok: false, error: 'INVALID_APPROVAL_DECISION' };
  const target = action === 'approve' ? 'approved' : 'rejected';
  const result = await dbBinding.query(
    `UPDATE github_repository_creation_approvals
        SET state = $2, decided_at = now()
      WHERE approval_id = $1
        AND state = 'pending'
        AND expires_at > now()
      RETURNING approval_id, repo, name, description, state, requested_at, expires_at, decided_at`,
    [id, target],
  );
  const row = result.rows?.[0] || null;
  if (!row) return { ok: false, error: 'APPROVAL_NOT_PENDING' };
  return { ok: true, approval: row };
}

export async function runGithubRepositoryApprovalRegressionTests() {
  const results = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  async function test(name, fn) { try { await fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); } }
  const fixture = { name: 'fixture', description: 'fixture', repo: `${OWNER}/fixture` };
  await test('approval identity binds exact repository policy and description', async () => {
    const a = await repositoryCreationRequestSha(fixture);
    const b = await repositoryCreationRequestSha({ ...fixture, description: 'different' });
    check(a !== b, 'description change reused approval identity');
  });
  await test('approval link contains only opaque approval id', async () => {
    const path = approvalPath('00000000-0000-0000-0000-000000000001');
    check(path.includes('approval_id=') && !path.includes('fixture'), 'approval path leaked mutable request fields');
  });
  const failed = results.filter((item) => !item.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}