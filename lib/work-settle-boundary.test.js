import { canonicalSettleCommandByRef } from 'lib/operator-commands.js';
import { legacyProjectionForStage, resolveCompletedStage } from 'lib/work-lifecycle.js';
import { WORK_SETTLE_INPUT_SCHEMA } from 'lib/work-settle-contract.js';
import { validateSemanticWorkerCommand } from 'lib/worker-transport.js';

const LEASE_REF = '00000000-0000-4000-8000-000000000145';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(name, fn) {
  try {
    await fn();
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, error: String(error?.message || error) };
  }
}

function boundaryDb() {
  return {
    async query(sql, params) {
      if (sql.includes('WHERE lease_id = $1')) {
        check(params?.[0] === LEASE_REF, 'canonical settlement looked up a different lease reference');
        return { rows: [{ lease_id: LEASE_REF, run_id: 'settle-boundary-run', work_ref: 'settle-boundary-work', gate: 'lane:verification', status: 'active', expires_at: '2026-08-27T18:00:00Z' }] };
      }
      throw new Error('unexpected database query in work.settle boundary regression');
    },
  };
}

function typeMatches(value, expected) {
  if (expected === 'null') return value === null;
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === expected;
}

function schemaAccepts(schema, value) {
  if (!schema || typeof schema !== 'object') return true;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => typeMatches(value, type))) return false;
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !Object.is(value, schema.const)) return false;
  if (schema.enum && !schema.enum.some(candidate => Object.is(candidate, value))) return false;

  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) return false;
    if (schema.maxLength != null && value.length > schema.maxLength) return false;
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) return false;
  }

  if (Array.isArray(value) && schema.items) {
    if (!value.every(item => schemaAccepts(schema.items, item))) return false;
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.required && schema.required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) return false;
    if (schema.properties) {
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key) && !schemaAccepts(propertySchema, value[key])) return false;
      }
      if (schema.additionalProperties === false) {
        const known = new Set(Object.keys(schema.properties));
        if (Object.keys(value).some(key => !known.has(key))) return false;
      }
    }
  }

  if (schema.allOf && !schema.allOf.every(part => schemaAccepts(part, value))) return false;
  if (schema.anyOf && !schema.anyOf.some(part => schemaAccepts(part, value))) return false;
  if (schema.oneOf && schema.oneOf.filter(part => schemaAccepts(part, value)).length !== 1) return false;
  if (schema.not && schemaAccepts(schema.not, value)) return false;
  if (schema.if) {
    const matched = schemaAccepts(schema.if, value);
    if (matched && schema.then && !schemaAccepts(schema.then, value)) return false;
    if (!matched && schema.else && !schemaAccepts(schema.else, value)) return false;
  }
  return true;
}

export async function runWorkSettleBoundaryTests() {
  const results = [];

  results.push(await run('shared work.settle contract and semantic worker transport expose one semantic shape', async () => {
    const required = new Set(WORK_SETTLE_INPUT_SCHEMA?.required || []);
    const properties = WORK_SETTLE_INPUT_SCHEMA?.properties || {};
    check(required.has('lease_ref') && required.has('disposition'), 'shared work.settle contract is missing required semantic fields');
    check(!required.has('lease_token') && !properties.lease_token, 'shared work.settle contract exposes lease capability material');
    check(Boolean(properties.lifecycle_facts), 'shared work.settle contract does not expose lifecycle_facts');
    check(Boolean(properties.operating_condition), 'shared work.settle contract does not expose operating_condition');
    check(!properties.next_state && !properties.next_lane, 'shared work.settle contract exposes caller-selected successor fields');

    const semantic = validateSemanticWorkerCommand('work.settle', {
      lease_ref: LEASE_REF,
      disposition: 'completed',
      operating_condition: 'NOMINAL',
      lifecycle_facts: {
        condition: 'NOMINAL',
        responsibilities: {
          ENABLE: { applicable: true, satisfied: true },
          ACQUIRE: { applicable: false, satisfied: true },
          EXECUTE: { applicable: true, satisfied: false },
          COMMIT: { applicable: true, satisfied: false },
          CONFIRM: { applicable: true, satisfied: false },
        },
      },
    });
    check(semantic.lifecycle_facts?.responsibilities?.ACQUIRE?.applicable === false, 'semantic worker transport changed lifecycle facts');

    for (const unsupported of [{ lease_token: 'secret-capability' }, { next_state: 'Done' }, { next_lane: 'lane:integration' }]) {
      let error = null;
      try { validateSemanticWorkerCommand('work.settle', { lease_ref: LEASE_REF, disposition: 'completed', ...unsupported }); }
      catch (caught) { error = caught; }
      check(error?.code === 'REQUEST_INVALID', `semantic worker transport accepted unsupported settlement field ${Object.keys(unsupported)[0]}`);
    }
  }));

  results.push(await run('work.settle discovery expresses disposition-dependent request-local rules', async () => {
    const base = { lease_ref: LEASE_REF };
    const lifecycleFacts = { condition: 'NOMINAL', responsibilities: { EXECUTE: { applicable: true, satisfied: true } } };
    const cases = [
      ['completed minimal', { ...base, disposition: 'completed' }, true],
      ['completed lifecycle facts', { ...base, disposition: 'completed', lifecycle_facts: lifecycleFacts }, true],
      ['completed rejects requeue class', { ...base, disposition: 'completed', requeue_class: 'retry_runtime_failure' }, false],
      ['completed rejects off-nominal condition', { ...base, disposition: 'completed', operating_condition: 'HOLD' }, false],
      ['blocked defaults condition server-side', { ...base, disposition: 'blocked', reason: 'dependency unavailable', promotion_condition: 'dependency becomes available' }, true],
      ['blocked accepts explicit off-nominal condition', { ...base, disposition: 'blocked', reason: 'dependency unavailable', promotion_condition: 'dependency becomes available', operating_condition: 'FAULT' }, true],
      ['blocked rejects missing reason', { ...base, disposition: 'blocked', promotion_condition: 'dependency becomes available' }, false],
      ['blocked rejects blank reason', { ...base, disposition: 'blocked', reason: '   ', promotion_condition: 'dependency becomes available' }, false],
      ['blocked rejects missing promotion condition', { ...base, disposition: 'blocked', reason: 'dependency unavailable' }, false],
      ['blocked rejects NOMINAL condition', { ...base, disposition: 'blocked', reason: 'dependency unavailable', promotion_condition: 'dependency becomes available', operating_condition: 'NOMINAL' }, false],
      ['blocked rejects requeue class', { ...base, disposition: 'blocked', reason: 'dependency unavailable', promotion_condition: 'dependency becomes available', requeue_class: 'retry_runtime_failure' }, false],
      ['blocked rejects lifecycle facts', { ...base, disposition: 'blocked', reason: 'dependency unavailable', promotion_condition: 'dependency becomes available', lifecycle_facts: lifecycleFacts }, false],
      ['requeue minimal', { ...base, disposition: 'requeue' }, true],
      ['requeue rejects off-nominal condition', { ...base, disposition: 'requeue', operating_condition: 'HOLD' }, false],
      ['requeue rejects lifecycle facts', { ...base, disposition: 'requeue', lifecycle_facts: lifecycleFacts }, false],
      ['wait_for_observable_change requires reason', { ...base, disposition: 'requeue', requeue_class: 'wait_for_observable_change' }, false],
      ['wait_for_observable_change accepts reason', { ...base, disposition: 'requeue', requeue_class: 'wait_for_observable_change', reason: 'waiting for a new upstream observation' }, true],
    ];

    for (const [name, input, expected] of cases) {
      check(schemaAccepts(WORK_SETTLE_INPUT_SCHEMA, input) === expected, `work.settle discovery case ${name} did not match expected validity ${expected}`);
    }

    const requeueClasses = WORK_SETTLE_INPUT_SCHEMA.properties.requeue_class.enum.filter(value => value !== null);
    for (const requeueClass of requeueClasses) {
      const valid = {
        ...base,
        disposition: 'requeue',
        requeue_class: requeueClass,
        ...(requeueClass === 'wait_for_observable_change' ? { reason: 'waiting for a new upstream observation' } : {}),
      };
      check(schemaAccepts(WORK_SETTLE_INPUT_SCHEMA, valid), `work.settle discovery rejects valid requeue class ${requeueClass}`);
      check(!schemaAccepts(WORK_SETTLE_INPUT_SCHEMA, { ...valid, disposition: 'completed' }), `work.settle discovery allows requeue class ${requeueClass} outside requeue`);
    }

    const requeueDescription = String(WORK_SETTLE_INPUT_SCHEMA.properties.requeue_class.description || '');
    const continuationDescription = String(WORK_SETTLE_INPUT_SCHEMA.properties.continuation.description || '');
    check(requeueDescription.includes('stale_candidate') && requeueDescription.includes('exact candidate'), 'work.settle discovery does not document stale_candidate effective-continuation requirement');
    check(requeueDescription.includes('resume_progress') && requeueDescription.includes('durable checkpoint'), 'work.settle discovery does not document resume_progress effective-continuation requirement');
    check(requeueDescription.includes('effective continuation') && continuationDescription.includes('durable checkpoint'), 'work.settle discovery does not explain server-derived effective continuation');
  }));

  results.push(await run('lease_ref settlement canonicalization derives stable retry identity without capability material', async () => {
    const db = boundaryDb();
    const input = { lease_ref: LEASE_REF, disposition: 'requeue', evidence: [{ kind: 'regression', ref: 'overcenter-settle-boundary' }], requeue_class: 'retry_runtime_failure' };
    const first = await canonicalSettleCommandByRef(input, db);
    const second = await canonicalSettleCommandByRef(input, db);
    check(first.lease_ref === LEASE_REF && second.lease_ref === LEASE_REF, 'canonical settlement lost lease_ref');
    check(!('lease_token' in first) && !('lease_token' in second), 'canonical settlement reconstructed or exposed lease capability material');
    check(first.run_id === 'settle-boundary-run', 'canonical settlement did not derive run correlation from the lease reference');
    check(/^auto:work\.settle:[0-9a-f]{64}$/.test(first.idempotency_key), 'canonical settlement did not derive a bounded retry identity');
    check(first.idempotency_key === second.idempotency_key, 'exact settlement replay changed retry identity');
  }));

  results.push(await run('completed Enable lifecycle facts skip non-applicable Acquire and select Execute without caller routing', async () => {
    const lifecycle = resolveCompletedStage({
      current_stage: 'ENABLE',
      lifecycle_facts: {
        condition: 'NOMINAL',
        responsibilities: {
          ENABLE: { applicable: true, satisfied: true },
          ACQUIRE: { applicable: false, satisfied: true },
          EXECUTE: { applicable: true, satisfied: false },
          COMMIT: { applicable: true, satisfied: false },
          CONFIRM: { applicable: true, satisfied: false },
        },
      },
    });
    const successor = legacyProjectionForStage(lifecycle.next_stage, 'lane:enable');
    check(lifecycle.current_stage === 'ENABLE', 'lifecycle resolver changed the current stage');
    check(lifecycle.next_stage === 'EXECUTE' && lifecycle.transition_kind === 'forward_bypass', 'lifecycle resolver did not bypass non-applicable Acquire');
    check(successor.state === 'Todo' && successor.lane === 'lane:repo-implementation', 'legacy projection did not derive the Execute successor');
  }));

  return {
    ok: results.every(result => result.ok),
    passed: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length,
    results,
  };
}
