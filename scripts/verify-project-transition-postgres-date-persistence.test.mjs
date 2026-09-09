import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareProjectTransitionLeasePersistence } from '../lib/project-transition-lease-store.js';
import { createProjectTransitionLeaseService } from '../lib/project-transition-leases.js';
import { PRODUCTIVE_STAGES } from '../lib/work-lifecycle.js';
import { createCloudRunDatabaseBinding } from './cloud-run-database-binding.mjs';

function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [
    stage,
    { applicable:true, satisfied:stageIndex < index },
  ]));
}

test('Cloud Run project transition acquisition canonicalizes node-postgres Date deadlines before durable persistence', async () => {
  const deadline = new Date('2026-08-27T14:00:00.000Z');
  const run = Object.freeze({ run_id:'run-pg-date', status:'active', deadline_at:deadline });
  const pgPool = {
    async query() { return { rows:[run] }; },
    async connect() { throw new Error('transaction client is not needed by this focused adapter probe'); },
  };
  const db = createCloudRunDatabaseBinding(pgPool);
  let persisted = null;
  const store = {
    async getRun(runId) {
      const result = await db.query('SELECT run');
      return result.rows.find(row => row.run_id === runId) || null;
    },
    async getLease() { return null; },
    async getLeaseByAcquireIdempotency() { return null; },
    async getSlot() { return null; },
    async updateLease() { return null; },
    async deleteSlot() {},
    async acquireLeaseAtomically(row) {
      persisted = await prepareProjectTransitionLeasePersistence(row, { capabilityToken:'test-capability' });
      return row;
    },
  };
  const graph = Object.freeze({
    schema:'project-graph-authority-v1',
    project_ref:'github:laurajoyhutchins/overcenter',
    authority:Object.freeze({
      definition:Object.freeze({
        kind:'github',
        repository:'laurajoyhutchins/overcenter',
        revision:'1'.repeat(40),
        derivation:'overcenter-project-graph-v1',
      }),
      observations:Object.freeze([]),
    }),
    nodes:Object.freeze([Object.freeze({
      id:'transition-a',
      priority:1,
      requires:Object.freeze([]),
      lifecycle:Object.freeze({
        current_stage:'ENABLE',
        responsibilities:Object.freeze(responsibilitiesFor('ENABLE')),
      }),
      executor:Object.freeze({ kind:'agent', role:'engineering', skill:'implementation' }),
      phase_bindings:Object.freeze({}),
    })]),
    horizons:Object.freeze([]),
  });
  const service = createProjectTransitionLeaseService({
    store,
    readProjectGraph:async () => graph,
    now:() => '2026-08-27T13:00:00.000Z',
    uuid:() => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });

  const result = await service.acquire({
    run_id:run.run_id,
    project_ref:graph.project_ref,
    transition_id:'transition-a',
    lease_seconds:600,
    idempotency_key:'pg-date-regression',
  });

  assert.equal(result.ok, true);
  assert.ok(persisted);
  assert.equal(typeof persisted.hard_expires_at, 'string');
  assert.equal(persisted.hard_expires_at, deadline.toISOString());
});
