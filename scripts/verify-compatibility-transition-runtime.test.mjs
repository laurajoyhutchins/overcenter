import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCompatibilityWorkSettlementReader,
  createCompatibilityTransitionConfirmationRuntime,
} from '../lib/compatibility-transition-confirmation-runtime.js';

test('runtime accepts only a durable completed CONFIRM settlement as compatibility evidence', async () => {
  const db={async query(sql,params){assert.match(sql,/work_leases/);assert.deepEqual(params,['LJH-522']);return{rows:[{lease_id:'settle-1',status:'settled',settled_at:'2026-08-29T14:12:13.736Z',settle_receipt:{ok:true,disposition:'completed',current_state:'Done',execution_precondition_verified:true,lifecycle_resolution:{current_stage:'CONFIRM',next_stage:'DONE',condition:'NOMINAL',complete:true},evidence:[{kind:'github_actions',ref:'exact-revision-v8:33256739256:success'}]}}]};}};
  const reader=createCompatibilityWorkSettlementReader(db);
  const result=await reader.requireCompleted({work_ref:'LJH-522'});
  assert.equal(result.ok,true);
  assert.equal(result.confirm_complete,true);
  assert.equal(result.settlement_ref,'settle-1');
  assert.equal(result.evidence.length,1);
});

test('runtime fails closed when latest durable work settlement is not CONFIRM to DONE', async () => {
  const db={async query(){return{rows:[{lease_id:'settle-2',status:'settled',settle_receipt:{ok:true,disposition:'completed',current_state:'Done',execution_precondition_verified:true,lifecycle_resolution:{current_stage:'COMMIT',next_stage:'CONFIRM',condition:'NOMINAL',complete:false},evidence:[{kind:'github_commit',ref:'abc'}]}}]};}};
  const reader=createCompatibilityWorkSettlementReader(db);
  await assert.rejects(()=>reader.requireCompleted({work_ref:'LJH-522'}),error=>error?.code==='COMPATIBILITY_WORK_NOT_CONFIRMED');
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