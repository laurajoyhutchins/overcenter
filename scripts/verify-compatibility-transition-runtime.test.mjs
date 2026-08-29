// Regression uses the real legacy receipt shape: verification evidence lives in the exact run journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCompatibilityWorkSettlementReader,
  createCompatibilityTransitionConfirmationRuntime,
} from '../lib/compatibility-transition-confirmation-runtime.js';

test('runtime accepts only a durable completed CONFIRM settlement as compatibility evidence', async () => {
  const db={async query(sql,params){assert.match(sql,/work_leases/);assert.deepEqual(params,['LJH-522']);return{rows:[{lease_id:'settle-1',run_id:'run-1',status:'settled',settled_at:'2026-08-29T14:12:13.736Z',settle_receipt:{ok:true,disposition:'completed',current_state:'Done',execution_precondition_verified:true,lifecycle_resolution:{current_stage:'CONFIRM',next_stage:'DONE',condition:'NOMINAL',complete:true},evidence:[{kind:'github_actions',ref:'exact-revision-v8:33256739256:success'}]}}]};}};
  const reader=createCompatibilityWorkSettlementReader(db);
  const result=await reader.requireCompleted({work_ref:'LJH-522'});
  assert.equal(result.ok,true);
  assert.equal(result.confirm_complete,true);
  assert.equal(result.settlement_ref,'settle-1');
  assert.equal(result.evidence.length,1);
});

test('runtime derives missing legacy evidence only from successful source integration and verified production promotion in the exact settlement run', async () => {
  const calls=[];
  const db={async query(sql,params){calls.push({sql,params});if(/FROM work_leases/.test(sql))return{rows:[{lease_id:'settle-real',run_id:'run-real',status:'settled',settled_at:'2026-08-29T14:12:13.736Z',settle_receipt:{ok:true,disposition:'completed',current_state:'Done',execution_precondition_verified:true,lifecycle_resolution:{current_stage:'CONFIRM',next_stage:'DONE',condition:'NOMINAL',complete:true}}}]};if(/orchestration_command_invocations/.test(sql)){assert.deepEqual(params,['run-real']);return{rows:[{command:'github.integration.reconcile',completed_at:'2026-08-29T14:07:08Z',result_projection:{repo:'laurajoyhutchins/overcenter',outcome:'merged',merge_commit_sha:'43e430747b3d7f43e95cf440b74abe90731ac497'}},{command:'github.production.promote',completed_at:'2026-08-29T14:13:07Z',result_projection:{repo:'laurajoyhutchins/overcenter',verified:true,new_production_head:'5d19fdd68ee6b021b8edc611651fbdc85c7c3340',verification_run_id:33256919705}}]};}throw new Error('unexpected query');}};
  const reader=createCompatibilityWorkSettlementReader(db);
  const result=await reader.requireCompleted({work_ref:'LJH-522'});
  assert.equal(result.confirm_complete,true);
  assert.deepEqual(result.evidence,[
    {kind:'github_integration',ref:'laurajoyhutchins/overcenter@43e430747b3d7f43e95cf440b74abe90731ac497'},
    {kind:'production_verification',ref:'laurajoyhutchins/overcenter@5d19fdd68ee6b021b8edc611651fbdc85c7c3340#run:33256919705'},
  ]);
  assert.equal(calls.length,2);
});

test('runtime fails closed when latest durable work settlement is not CONFIRM to DONE', async () => {
  const db={async query(){return{rows:[{lease_id:'settle-2',run_id:'run-2',status:'settled',settle_receipt:{ok:true,disposition:'completed',current_state:'Done',execution_precondition_verified:true,lifecycle_resolution:{current_stage:'COMMIT',next_stage:'CONFIRM',condition:'NOMINAL',complete:false},evidence:[{kind:'github_commit',ref:'abc'}]}}]};}};
  const reader=createCompatibilityWorkSettlementReader(db);
  await assert.rejects(()=>reader.requireCompleted({work_ref:'LJH-522'}),error=>error?.code==='COMPATIBILITY_WORK_NOT_CONFIRMED');
});

test('runtime fails closed when a legacy settlement has no same-run source and production proof', async () => {
  const db={async query(sql){if(/FROM work_leases/.test(sql))return{rows:[{lease_id:'settle-3',run_id:'run-3',status:'settled',settled_at:'2026-08-29T14:12:13.736Z',settle_receipt:{ok:true,disposition:'completed',current_state:'Done',execution_precondition_verified:true,lifecycle_resolution:{current_stage:'CONFIRM',next_stage:'DONE',condition:'NOMINAL',complete:true}}}]};return{rows:[{command:'github.integration.reconcile',result_projection:{repo:'laurajoyhutchins/overcenter',outcome:'merged',merge_commit_sha:'a'.repeat(40)}}]};}};
  const reader=createCompatibilityWorkSettlementReader(db);
  await assert.rejects(()=>reader.requireCompleted({work_ref:'LJH-522'}),error=>error?.code==='COMPATIBILITY_WORK_EVIDENCE_REQUIRED');
});

test('host-neutral runtime wires binding and fails before transition authority for unknown work', async () => {
  const calls=[];
  const service=createCompatibilityTransitionConfirmationRuntime({
    db:{async query(){return{rows:[]};}},
    bindings:{async resolve(input){calls.push(['binding',input]);return null;}},
    compatibilityWork:{async requireCompleted(input){calls.push(['work',input]);return null;}},
    readProjectGraph:async(input)=>{calls.push(['graph',input]);return null;},
    projectTransitions:{async require(input){calls.push(['require',input]);},async settle(input){calls.push(['settle',input]);}},
  });
  await assert.rejects(()=>service.confirm({run_id:'run-1',work_ref:'unknown',lease_ref:'lease-1'}),error=>error?.code==='COMPATIBILITY_TRANSITION_BINDING_NOT_FOUND');
  assert.equal(calls[0][0],'binding');
  assert.equal(calls.some(([kind])=>kind==='require'),false);
});