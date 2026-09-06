import { canonicalJson } from './canonical-json.js';
function text(value, field) { const out=typeof value==='string'?value.trim():''; if(!out) throw new TypeError(`${field} is required`); return out; }
function eventFromRow(row) { if(!row) return null; const value=row.event_json&&typeof row.event_json==='object'?row.event_json:null; return value?Object.freeze({ ...value, binding_sha256:row.binding_sha256 }):null; }
export function createPostgresProjectArtifactBindingStore(db) {
  if(!db||typeof db.query!=='function') throw new TypeError('db is required');
  async function get(bindingSha256) { const result=await db.query('SELECT binding_sha256,event_json FROM project_artifact_binding_events WHERE binding_sha256=$1 LIMIT 1',[text(bindingSha256,'binding_sha256')]); return eventFromRow(result.rows?.[0]||null); }
  async function appendEvent(event) {
    const result=await db.query(`INSERT INTO project_artifact_binding_events (binding_sha256,project_ref,transition_id,operation,authority_repository,authority_revision,artifact_provider,artifact_repository,artifact_kind,artifact_number,artifact_node_id,artifact_state,relationship,satisfaction_condition,prior_binding_sha256,event_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb) ON CONFLICT (binding_sha256) DO NOTHING RETURNING binding_sha256,event_json`,[event.binding_sha256,event.project_ref,event.transition_id,event.operation,event.authority.repository,event.authority.revision,event.artifact.provider,event.artifact.repository,event.artifact.kind,event.artifact.number,event.artifact.node_id,event.artifact.state,event.relationship,event.satisfaction_condition,event.prior_binding_sha256||null,canonicalJson(event)]);
    if(result.rows?.[0]) return eventFromRow(result.rows[0]); const existing=await get(event.binding_sha256); if(existing&&canonicalJson(existing)===canonicalJson(event)) return existing; const error=new Error('binding identity already exists with different evidence'); error.code='PROJECT_ARTIFACT_BINDING_IDENTITY_CONFLICT'; throw error;
  }
  async function readCurrentBinding({project_ref,transition_id}) { const result=await db.query(`SELECT binding_sha256,event_json FROM project_artifact_binding_events WHERE project_ref=$1 AND transition_id=$2 ORDER BY created_at DESC,binding_sha256 DESC LIMIT 1`,[text(project_ref,'project_ref'),text(transition_id,'transition_id')]); const latest=eventFromRow(result.rows?.[0]||null); return latest?.operation==='revoke'?null:latest; }
  return Object.freeze({get,appendEvent,readCurrentBinding});
}
