import { db } from 'hatchable';
import { canonicalJson, sha256Text } from 'lib/canonical-json.js';

const POLICY_SCHEMA = 'worker-skill-policy-v1';
const STATE_SCHEMA = 'worker-skill-state-v1';
const CATALOG_REVISION = 'worker-skills-v1';
const TERMINAL = new Set(['completed','failed','canceled']);
const COMPLETION_OUTCOMES = new Set(['completed','failed','canceled']);

const SKILLS = Object.freeze({
  'brainstorming': Object.freeze({
    name:'brainstorming', revision:'superpowers-brainstorming-v1', reference:'skills://plugins/superpowers/brainstorming/skill.md',
  }),
  'writing-plans': Object.freeze({
    name:'writing-plans', revision:'superpowers-writing-plans-v1', reference:'skills://plugins/superpowers/writing-plans/skill.md',
  }),
  'test-driven-development': Object.freeze({
    name:'test-driven-development', revision:'superpowers-test-driven-development-v1', reference:'skills://plugins/superpowers/test-driven-development/skill.md',
  }),
  'systematic-debugging': Object.freeze({
    name:'systematic-debugging', revision:'superpowers-systematic-debugging-v1', reference:'skills://plugins/superpowers/systematic-debugging/skill.md',
  }),
  'requesting-code-review': Object.freeze({
    name:'requesting-code-review', revision:'superpowers-requesting-code-review-v1', reference:'skills://plugins/superpowers/requesting-code-review/skill.md',
  }),
  'verification-before-completion': Object.freeze({
    name:'verification-before-completion', revision:'superpowers-verification-before-completion-v1', reference:'skills://plugins/superpowers/verification-before-completion/skill.md',
  }),
});

function err(code, message, details = null) { const error = new Error(message); error.code = code; error.details = details; return error; }
function text(value, field, max = 512) { const out = typeof value === 'string' ? value.trim() : ''; if (!out || out.length > max) throw err('REQUEST_INVALID', `${field} is invalid`, { field }); return out; }
function optionalText(value, field, max = 1000) { if (value == null || value === '') return null; return text(String(value), field, max); }
function cloneSkill(skill, extra = {}) { return { name:skill.name, revision:skill.revision, reference:skill.reference, ...extra }; }

export function resolveWorkerSkillPolicy(worker) {
  const workerName = text(worker, 'worker', 256);
  const implementation = /Implementation/i.test(workerName);
  const required = implementation
    ? [cloneSkill(SKILLS['verification-before-completion'], { required_before:'work.complete' })]
    : [];
  const available = implementation
    ? ['brainstorming','writing-plans','test-driven-development','systematic-debugging','requesting-code-review'].map((name)=>cloneSkill(SKILLS[name]))
    : [];
  return {
    schema:POLICY_SCHEMA,
    source:'server',
    catalog_revision:CATALOG_REVISION,
    worker:workerName,
    required,
    available,
    forbidden:[],
  };
}

function historicalPolicy(worker) {
  return { schema:POLICY_SCHEMA, source:'historical_unknown', catalog_revision:null, worker:worker || null, required:[], available:[], forbidden:[] };
}

export function normalizedStoredSkillPolicy(run) {
  const value = run?.skill_policy;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== POLICY_SCHEMA) return historicalPolicy(run?.worker || null);
  return value;
}

function publicActivation(row) {
  if (!row) return null;
  return {
    activation_id:row.activation_id,
    run_id:row.run_id,
    skill:row.skill_name,
    revision:row.skill_revision,
    reference:row.skill_reference,
    reason:row.reason || null,
    status:row.status,
    evidence:Array.isArray(row.evidence) ? row.evidence : [],
    created_at:row.created_at || null,
    completed_at:row.completed_at || null,
  };
}

function normalizeEvidence(value) {
  const source = value == null ? [] : value;
  if (!Array.isArray(source) || source.length > 50) throw err('REQUEST_INVALID', 'evidence must be an array of at most 50 entries', { field:'evidence' });
  return source.map((item,index)=>{
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw err('REQUEST_INVALID', `evidence[${index}] is invalid`, { field:`evidence[${index}]` });
    const unknown = Object.keys(item).filter((key)=>!['kind','ref'].includes(key));
    if (unknown.length) throw err('REQUEST_INVALID', `evidence[${index}] contains unsupported fields`, { field:`evidence[${index}]`, unsupported_fields:unknown.sort() });
    return { kind:text(item.kind, `evidence[${index}].kind`, 128), ref:text(item.ref, `evidence[${index}].ref`, 1000) };
  });
}

function permittedSkill(policy, name) {
  return [...(policy.required || []), ...(policy.available || [])].find((entry)=>entry.name === name) || null;
}

export function projectSkillState(run, activations = []) {
  const policy = normalizedStoredSkillPolicy(run);
  const publicActivations = activations.map(publicActivation).filter(Boolean);
  const completedNames = new Set(publicActivations.filter((entry)=>entry.status === 'completed').map((entry)=>entry.skill));
  return {
    schema:STATE_SCHEMA,
    run_id:run?.run_id || null,
    policy,
    active:publicActivations.filter((entry)=>entry.status === 'active'),
    completed:publicActivations.filter((entry)=>entry.status === 'completed'),
    failed:publicActivations.filter((entry)=>entry.status === 'failed' || entry.status === 'canceled'),
    remaining_required:(policy.required || []).filter((entry)=>!completedNames.has(entry.name)),
  };
}

export function createSkillExecutionService({ store } = {}) {
  if (!store) throw new TypeError('store is required');

  async function activate(input = {}) {
    const runId = text(input.run_id, 'run_id', 512);
    const skillName = text(input.skill, 'skill', 128);
    const reason = optionalText(input.reason, 'reason', 1000);
    const run = await store.getRun(runId);
    if (!run) throw err('RUN_NOT_FOUND', 'orchestration run was not found', { run_id:runId });
    if (run.status !== 'active') throw err('RUN_NOT_ACTIVE', 'orchestration run is not active', { run_id:runId, status:run.status || null });
    const policy = normalizedStoredSkillPolicy(run);
    const skill = permittedSkill(policy, skillName);
    if (!skill) throw err('SKILL_NOT_PERMITTED', 'skill is not permitted by the run policy', { run_id:runId, skill:skillName });
    const existing = await store.getActivation(runId, skillName);
    if (existing) return { ok:true, ...publicActivation(existing), idempotent_replay:true };
    const created = await store.insertActivation({
      run_id:runId,
      skill_name:skill.name,
      skill_revision:skill.revision,
      skill_reference:skill.reference,
      reason,
    });
    return { ok:true, ...publicActivation(created), idempotent_replay:false };
  }

  async function complete(input = {}) {
    const activationId = text(input.activation_id, 'activation_id', 128);
    const outcome = text(input.outcome, 'outcome', 32).toLowerCase();
    if (!COMPLETION_OUTCOMES.has(outcome)) throw err('REQUEST_INVALID', 'outcome must be completed, failed, or canceled', { field:'outcome' });
    const evidence = normalizeEvidence(input.evidence);
    const completionHash = await sha256Text(canonicalJson({ outcome, evidence }));
    const activation = await store.getActivationById(activationId);
    if (!activation) throw err('SKILL_ACTIVATION_NOT_FOUND', 'skill activation was not found', { activation_id:activationId });
    if (TERMINAL.has(activation.status)) {
      if (activation.completion_sha256 === completionHash) return { ok:true, ...publicActivation(activation), idempotent_replay:true };
      throw err('IDEMPOTENCY_CONFLICT', 'skill activation was already completed with different semantics', { activation_id:activationId });
    }
    const completed = await store.completeActivation(activationId, outcome, evidence, completionHash);
    return { ok:true, ...publicActivation(completed), idempotent_replay:false };
  }

  async function state(input = {}) {
    const runId = text(input.run_id, 'run_id', 512);
    const run = await store.getRun(runId);
    if (!run) throw err('RUN_NOT_FOUND', 'orchestration run was not found', { run_id:runId });
    const activations = await store.listActivations(runId);
    return { ok:true, ...projectSkillState(run, activations) };
  }

  async function assertCompletionRequirements(input = {}) {
    const current = await state(input);
    const missing = current.remaining_required || [];
    if (missing.length) throw err('SKILL_REQUIREMENT_UNSATISFIED', 'required skill completion is missing', {
      run_id:current.run_id,
      missing:missing.map((entry)=>entry.name),
    });
    return current;
  }

  return { activate, complete, state, assertCompletionRequirements };
}

export function createPostgresSkillExecutionStore(dbBinding = db) {
  async function row(sql, values) { const result = await dbBinding.query(sql, values); return result.rows?.[0] || null; }
  return {
    async getRun(runId) { return row('SELECT run_id,worker,status,skill_policy FROM orchestration_runs WHERE run_id=$1', [runId]); },
    async getActivation(runId, skillName) { return row('SELECT * FROM orchestration_skill_activations WHERE run_id=$1 AND skill_name=$2', [runId,skillName]); },
    async getActivationById(activationId) { return row('SELECT * FROM orchestration_skill_activations WHERE activation_id=$1', [activationId]); },
    async insertActivation(value) {
      return row(`INSERT INTO orchestration_skill_activations (run_id,skill_name,skill_revision,skill_reference,reason)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (run_id,skill_name) DO UPDATE SET skill_name=EXCLUDED.skill_name
        RETURNING *`, [value.run_id,value.skill_name,value.skill_revision,value.skill_reference,value.reason]);
    },
    async completeActivation(activationId, status, evidence, completionSha) {
      return row(`UPDATE orchestration_skill_activations
        SET status=$2,evidence=$3::jsonb,completion_sha256=$4,completed_at=now()
        WHERE activation_id=$1 AND status='active'
        RETURNING *`, [activationId,status,JSON.stringify(evidence),completionSha]);
    },
    async listActivations(runId) {
      const result = await dbBinding.query('SELECT * FROM orchestration_skill_activations WHERE run_id=$1 ORDER BY created_at ASC, activation_id ASC', [runId]);
      return result.rows || [];
    },
  };
}

export function createPostgresSkillExecutionService(options = {}) {
  return createSkillExecutionService({ store:options.store || createPostgresSkillExecutionStore(options.db || db) });
}

export async function canonicalSkillCompleteCommand(input = {}, dbBinding = db) {
  const activationId = text(input.activation_id, 'activation_id', 128);
  const requestedRunId = input.run_id == null ? null : text(input.run_id, 'run_id', 512);
  const activation = await createPostgresSkillExecutionStore(dbBinding).getActivationById(activationId);
  if (!activation) throw err('SKILL_ACTIVATION_NOT_FOUND', 'skill activation was not found', { activation_id:activationId });
  if (requestedRunId && requestedRunId !== activation.run_id) {
    throw err('RUN_SCOPE_VIOLATION', 'skill activation belongs to a different orchestration run', { run_id:requestedRunId });
  }
  return { ...input, activation_id:activationId, run_id:activation.run_id };
}

export function statusForSkillExecutionError(error) {
  const code = String(error?.code || 'SKILL_EXECUTION_ERROR');
  if (code === 'REQUEST_INVALID') return 400;
  if (['RUN_NOT_FOUND','SKILL_ACTIVATION_NOT_FOUND'].includes(code)) return 404;
  if (['RUN_NOT_ACTIVE','RUN_SCOPE_VIOLATION','SKILL_NOT_PERMITTED','IDEMPOTENCY_CONFLICT','SKILL_REQUIREMENT_UNSATISFIED'].includes(code)) return 409;
  return 500;
}

export const skillExecutionConfig = Object.freeze({ policy_schema:POLICY_SCHEMA, state_schema:STATE_SCHEMA, catalog_revision:CATALOG_REVISION });