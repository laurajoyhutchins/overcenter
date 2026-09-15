import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createHighWaterOrchestrationMaintenanceService,
  normalizeMaintenanceIdentity,
} from '../lib/orchestration-maintenance-high-water.js';
import { createPostgresSubjectAwareOrchestrationMaintenanceService } from '../lib/orchestration-maintenance-subjects.js';

const REVISION_A = 'a'.repeat(40);
const REVISION_B = 'b'.repeat(40);
const EPOCH_A = '2026-09-15T14:00:00Z';
const EPOCH_B = '2026-09-15T15:00:00Z';

function maintenanceIdentity(revision = REVISION_A, epoch = EPOCH_A) {
  return Object.freeze({
    authoritative_revision:revision,
    timed_maintenance_epoch:epoch,
  });
}

function fakeDb(highWater = null) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const text = String(sql);
      if (text.includes('SELECT authoritative_revision,timed_maintenance_epoch,maintained_at')) {
        calls.push({ kind:'read', params });
        return { rows:highWater ? [highWater] : [] };
      }
      if (text.includes('INSERT INTO orchestration_maintenance_high_water')) {
        calls.push({ kind:'write', params });
        return {
          rows:[{
            authoritative_revision:params[1],
            timed_maintenance_epoch:params[2],
            maintained_at:params[3],
          }],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

function successfulDelegate(calls) {
  return {
    async maintain() {
      calls.push('maintain');
      return {
        ok:true,
        schema:'orchestration-maintenance-v1',
        actions:[],
        action_count:0,
        semantic_work_mutations:0,
        work_selection_performed:false,
      };
    },
  };
}

test('unchanged maintenance high-water exits before the maintenance sweep', async () => {
  const db = fakeDb({
    authoritative_revision:REVISION_A,
    timed_maintenance_epoch:new Date(EPOCH_A),
    maintained_at:new Date('2026-09-15T14:01:00Z'),
  });
  const delegateCalls = [];
  const service = createHighWaterOrchestrationMaintenanceService({
    db,
    delegate:successfulDelegate(delegateCalls),
    maintenanceIdentity:maintenanceIdentity(),
  });

  const result = await service.maintain();

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.skip_reason, 'HIGH_WATER_UNCHANGED');
  assert.deepEqual(delegateCalls, []);
  assert.deepEqual(db.calls.map((call) => call.kind), ['read']);
});

for (const scenario of [
  {
    name:'authoritative revision changes within the same timed epoch',
    highWater:{ authoritative_revision:REVISION_A, timed_maintenance_epoch:EPOCH_A },
    identity:maintenanceIdentity(REVISION_B, EPOCH_A),
  },
  {
    name:'timed maintenance epoch advances without a source revision change',
    highWater:{ authoritative_revision:REVISION_A, timed_maintenance_epoch:EPOCH_A },
    identity:maintenanceIdentity(REVISION_A, EPOCH_B),
  },
]) {
  test(scenario.name, async () => {
    const db = fakeDb(scenario.highWater);
    const delegateCalls = [];
    const service = createHighWaterOrchestrationMaintenanceService({
      db,
      delegate:successfulDelegate(delegateCalls),
      maintenanceIdentity:scenario.identity,
      now:() => '2026-09-15T15:17:00.000Z',
    });

    const result = await service.maintain();

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.deepEqual(delegateCalls, ['maintain']);
    assert.deepEqual(db.calls.map((call) => call.kind), ['read', 'write']);
    assert.equal(db.calls[1].params[1], scenario.identity.authoritative_revision);
    assert.equal(db.calls[1].params[2], scenario.identity.timed_maintenance_epoch);
  });
}

test('failed maintenance does not advance the high-water mark', async () => {
  const db = fakeDb(null);
  const expected = new Error('maintenance failed');
  const service = createHighWaterOrchestrationMaintenanceService({
    db,
    delegate:{ async maintain() { throw expected; } },
    maintenanceIdentity:maintenanceIdentity(),
  });

  await assert.rejects(service.maintain(), (error) => error === expected);
  assert.deepEqual(db.calls.map((call) => call.kind), ['read']);
});

test('non-success maintenance response does not advance the high-water mark', async () => {
  const db = fakeDb(null);
  const service = createHighWaterOrchestrationMaintenanceService({
    db,
    delegate:{ async maintain() { return { ok:false, schema:'orchestration-maintenance-v1' }; } },
    maintenanceIdentity:maintenanceIdentity(),
  });

  const result = await service.maintain();
  assert.equal(result.ok, false);
  assert.deepEqual(db.calls.map((call) => call.kind), ['read']);
});

test('maintenance without a timed identity preserves legacy full-sweep behavior', () => {
  const delegate = successfulDelegate([]);
  const service = createHighWaterOrchestrationMaintenanceService({
    db:null,
    delegate,
    maintenanceIdentity:null,
  });
  assert.equal(service, delegate);
});

test('maintenance identity is exact-revision and exact-UTC-hour fenced', () => {
  assert.deepEqual(normalizeMaintenanceIdentity(maintenanceIdentity()), maintenanceIdentity());
  assert.throws(
    () => normalizeMaintenanceIdentity({ authoritative_revision:'dev', timed_maintenance_epoch:EPOCH_A }),
    /exact 40-character lowercase Git revision/,
  );
  assert.throws(
    () => normalizeMaintenanceIdentity({ authoritative_revision:REVISION_A, timed_maintenance_epoch:'2026-09-15T14:17:00Z' }),
    /exact UTC hourly epoch/,
  );
  assert.throws(
    () => normalizeMaintenanceIdentity({ authoritative_revision:REVISION_A, timed_maintenance_epoch:'2026-02-30T14:00:00Z' }),
    /exact UTC hourly epoch/,
  );
});

test('subject-aware maintenance wrapper skips before reconciliation store reads', async () => {
  const db = fakeDb({
    authoritative_revision:REVISION_A,
    timed_maintenance_epoch:EPOCH_A,
    maintained_at:'2026-09-15T14:01:00Z',
  });
  const service = createPostgresSubjectAwareOrchestrationMaintenanceService({
    db,
    workLeases:{ claim() {}, settle() {} },
    projectTransitions:{},
    store:{
      async expiredSlots() { throw new Error('maintenance sweep should not have started'); },
    },
    compactRecoveries:[],
    maintenanceIdentity:maintenanceIdentity(),
  });

  const result = await service.maintain();
  assert.equal(result.skipped, true);
  assert.deepEqual(db.calls.map((call) => call.kind), ['read']);
});

test('maintenance workflow gates workflow_run on success and carries the high-water identity out of semantic input', async () => {
  const workflow = await readFile(new URL('../.github/workflows/gcp-orchestration-maintain.yml', import.meta.url), 'utf8');
  const transport = await readFile(new URL('../lib/worker-transport.js', import.meta.url), 'utf8');

  assert.match(workflow, /github\.event_name != 'workflow_run' \|\| github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /group: overcenter-gcp-semantic-control-plane/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /authoritative_revision="\$\(git rev-parse HEAD\)"/);
  assert.match(workflow, /test "\$authoritative_revision" = "\$\(git ls-remote origin refs\/heads\/dev \| cut -f1\)"/);
  assert.match(workflow, /timed_maintenance_epoch="\$\(date -u \+'%Y-%m-%dT%H:00:00Z'\)"/);
  assert.match(workflow, /invocation_context:\{run_id:\$request_id,maintenance_identity:/);
  assert.match(workflow, /input:\{\}/);
  assert.match(transport, /maintenanceIdentity:runtime\.invocationContext\?\.maintenance_identity \?\? null/);
});
