import test from 'node:test';
import assert from 'node:assert/strict';

import { createTargetAwareOrchestrationRunService } from '../lib/orchestration-run-targets.js';

const TARGET_A = Object.freeze({ project_ref:'portfolio:primary', horizon:Object.freeze({ kind:'project', ref:'portfolio:primary' }) });
const TARGET_B = Object.freeze({ project_ref:'portfolio:primary', horizon:Object.freeze({ kind:'milestone', ref:'later' }) });

function memoryStore() {
  const rows = new Map();
  const sameSha = (left, right) => (left || null) === (right || null);
  return {
    rows,
    async getRun(id) { return rows.get(id) || null; },
    async findPredecessorByTarget(key, scopeSha, targetSha, exclude) {
      return [...rows.values()]
        .filter((row) => row.continuation_key === key && row.scope_sha256 === scopeSha && row.run_id !== exclude && sameSha(row.target_sha256, targetSha) && row.status === 'finished')
        .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)))[0] || null;
    },
    async insertRunWithTarget(row, target, targetSha) {
      const saved = { ...row, target, target_sha256:targetSha };
      rows.set(saved.run_id, saved);
      return saved;
    },
  };
}

function fakeBaseService(store) {
  return {
    async start(input) {
      const existing = await store.getRun(input.run_id);
      if (existing) return { ...existing, idempotent_replay:true };
      const scopeSha = 'scope-sha';
      const predecessor = await store.findPredecessor(input.continuation_key, scopeSha, input.run_id);
      return store.insertRun({
        run_id:input.run_id,
        continuation_key:input.continuation_key,
        scope_sha256:scopeSha,
        predecessor_run_id:predecessor?.run_id || null,
        status:'active',
        started_at:`2026-08-26T20:00:0${store.rows.size}.000Z`,
      });
    },
    async resolveHorizon(input) { return { ok:true, schema:'orchestration-horizon-v1', run_id:input.run_id, ownership_granted:false }; },
  };
}

function responsibilities(done) {
  return Object.fromEntries(['ENABLE','ACQUIRE','EXECUTE','COMMIT','CONFIRM'].map((stage)=>[stage,{ applicable:true, satisfied:done }]));
}
function graph(revision, done = false) {
  return {
    schema:'project-graph-authority-v1',
    project_ref:'portfolio:primary',
    authority:{ definition:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision, derivation:'test-v1' }, observations:[] },
    nodes:[{ id:'build', priority:1, requires:[], lifecycle:{ current_stage:done?'CONFIRM':'ENABLE', responsibilities:responsibilities(done) }, executor:{ kind:'operator', command:'test.noop' } }],
    horizons:[{ kind:'milestone', ref:'later', target_node_ids:['build'] }],
  };
}
function service(store, projectGraphReader = null) {
  return createTargetAwareOrchestrationRunService({ store, createBaseService:fakeBaseService, projectGraphReader });
}
function startInput(runId, target = TARGET_A) { return { run_id:runId, continuation_key:'targeted:portfolio', target }; }

test('run target is immutable and exact replay retains it', async()=>{
  const store = memoryStore(); const runs = service(store);
  const started = await runs.start(startInput('run-target'));
  assert.deepEqual(started.target, TARGET_A);
  assert.deepEqual(store.rows.get('run-target').target, TARGET_A);
  const replay = await runs.start(startInput('run-target'));
  assert.equal(replay.idempotent_replay, true);
  assert.deepEqual(replay.target, TARGET_A);
  await assert.rejects(()=>runs.start(startInput('run-target', TARGET_B)), (error)=>error?.code === 'IDEMPOTENCY_CONFLICT');
});

test('predecessor recovery is isolated by exact target identity', async()=>{
  const store = memoryStore(); const runs = service(store);
  await runs.start(startInput('run-a', TARGET_A)); store.rows.get('run-a').status = 'finished';
  const different = await runs.start(startInput('run-b', TARGET_B)); assert.equal(different.predecessor_run_id, null);
  const same = await runs.start(startInput('run-c', TARGET_A)); assert.equal(same.predecessor_run_id, 'run-a');
});

test('targeted resolution rereads authority and never grants ownership', async()=>{
  const store = memoryStore(); let current = graph('a'.repeat(40)); let reads = 0;
  const runs = service(store, async({project_ref})=>{ assert.equal(project_ref, TARGET_A.project_ref); reads += 1; return current; });
  await runs.start(startInput('run-resolve', TARGET_A));
  const incomplete = await runs.resolveHorizon({run_id:'run-resolve'});
  assert.equal(incomplete.schema, 'project-horizon-evaluation-v1');
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.frontier[0]?.id, 'build');
  assert.equal(incomplete.horizon.authority.revision, 'a'.repeat(40));
  assert.equal(incomplete.ownership_granted, false);
  current = graph('b'.repeat(40), true);
  const complete = await runs.resolveHorizon({run_id:'run-resolve'});
  assert.equal(complete.complete, true);
  assert.equal(complete.horizon.authority.revision, 'b'.repeat(40));
  assert.equal(reads, 2);
});

test('target rejects caller-supplied membership or authority coordinates', async()=>{
  const store = memoryStore(); const runs = service(store);
  await assert.rejects(()=>runs.start(startInput('bad-membership',{...TARGET_A,target_node_ids:['build']})),(error)=>error?.code==='REQUEST_INVALID');
  await assert.rejects(()=>runs.start(startInput('bad-authority',{...TARGET_A,authority:{revision:'a'.repeat(40)}})),(error)=>error?.code==='REQUEST_INVALID');
});

test('untargeted runs preserve the legacy advisory horizon path and cannot inherit targeted predecessors', async()=>{
  const store = memoryStore(); const runs = service(store);
  await runs.start(startInput('targeted', TARGET_A)); store.rows.get('targeted').status = 'finished';
  const legacy = await runs.start({run_id:'legacy', continuation_key:'targeted:portfolio'});
  assert.equal(legacy.target, null);
  assert.equal(legacy.predecessor_run_id, null);
  const resolved = await runs.resolveHorizon({run_id:'legacy'});
  assert.equal(resolved.schema, 'orchestration-horizon-v1');
});