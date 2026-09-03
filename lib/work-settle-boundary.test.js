import { canonicalSettleCommandByRef } from 'lib/operator-commands.js';
import { createSubjectAwareLeaseSettlementService } from 'lib/orchestration-finish-runtime.js';
import { resolveCompletedStage } from 'lib/work-lifecycle.js';
import { legacyProjectionForStage } from 'lib/legacy-lane-compatibility.js';
import { WORK_SETTLE_INPUT_SCHEMA } from 'lib/work-settle-contract.js';
import { executeSemanticWorkerCommand, validateSemanticWorkerCommand } from 'lib/worker-transport.js';

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

    const conditionals = WORK_SETTLE_INPUT_SCHEMA?.allOf || [];
    check(conditionals.length >= 6, 'work.settle discovery does not expose disposition-dependent settlement rules');
    check(String(properties.operating_condition?.description || '').includes('HOLD') && String(properties.operating_condition?.description || '').includes('NOMINAL'), 'operating_condition discovery does not document runtime defaults');
    check(String(properties.continuation?.description || '').includes('effective continuation'), 'continuation discovery does not explain persisted effective continuation');

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

  results.push(await run('subject-aware settlement sends graph-native leases to project transition authority', async () => {
    let legacyCalls = 0;
    let transitionInput = null;
    const service = createSubjectAwareLeaseSettlementService({
      async readLease(leaseRef) {
        check(leaseRef === LEASE_REF, 'subject-aware settlement read a different lease');
        return { lease_id: LEASE_REF, run_id: 'settle-boundary-run', gate: 'project_transition', claim_receipt: { subject: 'project_transition' } };
      },
      legacyLeases: {
        async settleByRef() {
          legacyCalls += 1;
          throw new Error('graph-native settlement consulted legacy work authority');
        },
      },
      projectTransitions: {
        async settle(input) {
          transitionInput = input;
          return { ok: true, subject: 'project_transition' };
        },
      },
    });
    const evidence = [{ kind: 'regression', ref: 'subject-aware-settlement-provenance' }];
    const reason = 'preserve settlement provenance across subject dispatch';
    const result = await service.settleByRef({ lease_ref: LEASE_REF, disposition: 'requeue', evidence, reason, idempotency_key: 'settle-boundary-subject-dispatch' });
    check(result?.subject === 'project_transition', 'graph-native settlement did not return project transition result');
    check(legacyCalls === 0, 'graph-native settlement consulted legacy work authority');
    check(transitionInput?.run_id === 'settle-boundary-run', 'graph-native settlement did not derive durable run authority');
    check(transitionInput?.lease_ref === LEASE_REF && transitionInput?.disposition === 'requeue', 'graph-native settlement changed settlement semantics');
    check(JSON.stringify(transitionInput?.evidence) === JSON.stringify(evidence), 'graph-native settlement dropped evidence at subject dispatch');
    check(transitionInput?.reason === reason, 'graph-native settlement dropped reason at subject dispatch');
  }));

  results.push(await run('semantic worker work.settle uses subject-aware settlement runtime', async () => {
    const calls = [];
    const response = await executeSemanticWorkerCommand('work.settle', {
      lease_ref: LEASE_REF,
      disposition: 'requeue',
      evidence: [{ kind: 'regression', ref: 'graph-native-worker-settle' }],
    }, {
      db: boundaryDb(),
      workSettlement: {
        async settleByRef(input) {
          calls.push(input);
          return { ok: true, subject: 'project_transition', lease_ref: input.lease_ref, disposition: input.disposition };
        },
      },
      logger: { error() {} },
    });
    check(response.status === 200 && response.body?.ok === true, 'semantic worker work.settle did not use subject-aware settlement runtime');
    check(response.body?.subject === 'project_transition', 'semantic worker work.settle did not preserve graph-native settlement result');
    check(calls.length === 1 && calls[0].lease_ref === LEASE_REF, 'semantic worker work.settle changed the exact lease reference');
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
