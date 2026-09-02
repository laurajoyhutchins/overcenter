import { canonicalJson } from './canonical-json.js';

function text(value, name, max = 2048) {
  const out = typeof value === 'string' ? value.trim() : '';
  if (!out || out.length > max) throw new TypeError(`${name} is invalid`);
  return out;
}

function sha256(value, name = 'evidence_sha256') {
  const out = text(value, name, 64);
  if (!/^[0-9a-f]{64}$/.test(out)) throw new TypeError(`${name} must be lowercase SHA-256`);
  return out;
}

function iso(value, name) {
  const out = text(value, name, 64);
  const ms = Date.parse(out);
  if (!Number.isFinite(ms)) throw new TypeError(`${name} must be an ISO timestamp`);
  return new Date(ms).toISOString();
}

function refs(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('evidence_refs must be an array');
  return value;
}

function timestamp(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value);
}

function row(value) {
  if (!value) return null;
  return {
    ...value,
    evidence_refs:Array.isArray(value.evidence_refs) ? value.evidence_refs : [],
    satisfied_at:timestamp(value.satisfied_at),
    consumed_at:timestamp(value.consumed_at),
  };
}

function identity(input) {
  return {
    proof_key:text(input?.proof_key, 'proof_key'),
    subject_key:text(input?.subject_key, 'subject_key'),
    predicate_kind:text(input?.predicate_kind, 'predicate_kind', 256),
    authority_repository:text(input?.authority_repository, 'authority_repository'),
    authority_revision:text(input?.authority_revision, 'authority_revision'),
    evidence_sha256:sha256(input?.evidence_sha256),
    evidence_refs:refs(input?.evidence_refs),
    satisfied_at:iso(input?.satisfied_at, 'satisfied_at'),
  };
}

function conflict(existing, requested) {
  const fields = [
    'subject_key',
    'predicate_kind',
    'authority_repository',
    'authority_revision',
    'evidence_sha256',
  ];
  if (fields.some((field) => String(existing?.[field] ?? '') !== String(requested[field]))) return true;
  return canonicalJson(existing?.evidence_refs || []) !== canonicalJson(requested.evidence_refs || []);
}

function proofConflict(proofKey, existing, requested) {
  const error = new Error('proof_key is already bound to different authority or evidence');
  error.code = 'PROOF_IDENTITY_CONFLICT';
  error.details = {
    proof_key:proofKey,
    existing_authority_repository:existing?.authority_repository || null,
    existing_authority_revision:existing?.authority_revision || null,
    requested_authority_repository:requested.authority_repository,
    requested_authority_revision:requested.authority_revision,
  };
  return error;
}

export function createCompactProofStateStore(dbBinding) {
  if (!dbBinding || typeof dbBinding.query !== 'function') throw new TypeError('dbBinding is required');

  async function get(proofKey) {
    const result = await dbBinding.query(
      `SELECT * FROM proof_state WHERE proof_key=$1 LIMIT 1`,
      [text(proofKey, 'proof_key')],
    );
    return row(result.rows?.[0] || null);
  }

  async function satisfy(input = {}) {
    const proof = identity(input);
    const result = await dbBinding.query(
      `INSERT INTO proof_state (
         proof_key,subject_key,predicate_kind,authority_repository,authority_revision,
         evidence_sha256,evidence_refs,satisfied_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT (proof_key) DO NOTHING
       RETURNING *`,
      [
        proof.proof_key,
        proof.subject_key,
        proof.predicate_kind,
        proof.authority_repository,
        proof.authority_revision,
        proof.evidence_sha256,
        canonicalJson(proof.evidence_refs),
        proof.satisfied_at,
      ],
    );
    if (result.rows?.[0]) return row(result.rows[0]);
    const existing = await get(proof.proof_key);
    if (!existing) throw new Error('proof insert conflict could not be resolved');
    if (conflict(existing, proof)) throw proofConflict(proof.proof_key, existing, proof);
    return existing;
  }

  async function findSatisfied(input = {}) {
    const subjectKey = text(input.subject_key, 'subject_key');
    const predicateKind = text(input.predicate_kind, 'predicate_kind', 256);
    const repository = text(input.authority_repository, 'authority_repository');
    const revision = text(input.authority_revision, 'authority_revision');
    const result = await dbBinding.query(
      `SELECT *
         FROM proof_state
        WHERE subject_key=$1
          AND predicate_kind=$2
          AND authority_repository=$3
          AND authority_revision=$4
          AND consumed_at IS NULL
        ORDER BY satisfied_at DESC, proof_key ASC
        LIMIT 1`,
      [subjectKey, predicateKind, repository, revision],
    );
    return row(result.rows?.[0] || null);
  }

  async function consume(input = {}) {
    const proofKey = text(input.proof_key, 'proof_key');
    const repository = text(input.authority_repository, 'authority_repository');
    const revision = text(input.authority_revision, 'authority_revision');
    const consumedAt = iso(input.consumed_at, 'consumed_at');
    const result = await dbBinding.query(
      `UPDATE proof_state
          SET consumed_at=$4
        WHERE proof_key=$1
          AND authority_repository=$2
          AND authority_revision=$3
          AND consumed_at IS NULL
        RETURNING *`,
      [proofKey, repository, revision, consumedAt],
    );
    if (result.rows?.[0]) return row(result.rows[0]);
    const existing = await get(proofKey);
    if (
      existing
      && existing.authority_repository === repository
      && existing.authority_revision === revision
      && existing.consumed_at
    ) return existing;
    return null;
  }

  return Object.freeze({ get, satisfy, findSatisfied, consume });
}
