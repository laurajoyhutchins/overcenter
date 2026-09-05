import { canonicalJson, sha256Text } from './canonical-json.js';

const COMMAND = 'project.artifact.bind';
function required(value, field) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw new TypeError(`${field} is required`);
  return result;
}
function parsed(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}

export function createProjectArtifactBindingPostgresStore(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db is required');
  return Object.freeze({
    async record(event = {}) {
      const bindingId = required(event.binding_id, 'binding_id');
      const request = event.request || {};
      const requestHash = await sha256Text(canonicalJson(request));
      const now = new Date().toISOString();
      const operationId = crypto.randomUUID();
      const resolution = JSON.stringify({ schema:'project-artifact-binding-evidence-v1', binding:event.binding });
      const params = [operationId, COMMAND, request.project_ref, bindingId, requestHash, request.transition_id, request.expected_revision, resolution, now];
      const inserted = await db.query(
        `INSERT INTO operation_state (operation_id,command,idempotency_scope,idempotency_key,request_sha256,state,subject_key,authority_revision,may_have_mutated,effect_kind,effect_ref,result_sha256,resolution,created_at,updated_at,resolved_at)
         VALUES ($1,$2,$3,$4,$5,'succeeded',$6,$7,true,'project_artifact_binding',$4,$5,$8::jsonb,$9,$9,$9)
         ON CONFLICT (command,idempotency_scope,idempotency_key) DO NOTHING RETURNING *`,
        params,
      );
      const row = inserted?.rows?.[0];
      if (row) return Object.freeze({ outcome:'recorded', event:parsed(row.resolution) });
      const existing = await db.query(
        `SELECT * FROM operation_state WHERE command=$1 AND idempotency_scope=$2 AND idempotency_key=$3 LIMIT 1`,
        [COMMAND, request.project_ref, bindingId],
      );
      const prior = existing?.rows?.[0];
      if (!prior) throw new Error('artifact binding disappeared after idempotency conflict');
      if (String(prior.request_sha256 || '') !== requestHash) return Object.freeze({ outcome:'conflict', event:parsed(prior.resolution) });
      return Object.freeze({ outcome:'replay', event:parsed(prior.resolution) });
    },
    async list(projectRef) {
      const rows = await db.query(
        `SELECT resolution FROM operation_state WHERE command=$1 AND idempotency_scope=$2 AND state='succeeded' ORDER BY created_at ASC, operation_id ASC`,
        [COMMAND, required(projectRef, 'project_ref')],
      );
      return Object.freeze((rows?.rows || []).map((row) => parsed(row.resolution)?.binding).filter(Boolean));
    },
  });
}