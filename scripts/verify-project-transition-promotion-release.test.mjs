import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromotionAwareProjectTransitionLeaseService } from '../lib/project-transition-promotion-release.js';
import { successfulStageResponsibilities } from '../lib/work-lifecycle.js';

const projectRef='github:laurajoyhutchins/overcenter';
const revision='1'.repeat(40);
const transition={id:'transition-a',priority:1,requires:[],lifecycle:{current_stage:'ENABLE',responsibilities:successfulStageResponsibilities('ENABLE')},executor:{kind:'agent',role:'engineering',skill:'implementation'},phase_bindings:{}};
const graph={schema:'project-graph-authority-v1',project_ref:projectRef,authority:{definition:{kind:'github',repository:'laurajoyhutchins/overcenter',revision,derivation:'overcenter-project-graph-v1'},observations:[]},nodes:[transition],horizons:[]};

function fixture(){
  const operations=new Map(),leases=new Map(),slots=new Map();let currentRevision=revision;
  const runs=new Map([['run-1',{run_id:'run-1',status:'active',deadline_at:'2026-09-13T14:00:00Z'}]]);
  const store={
    async getRun(id){return runs.get(id)||null;},async getLease(id){return leases.get(id)||null;},async getLeaseByAcquireIdempotency(key){return [...leases.values()].find(row=>row.acquire_idempotency_key===key)||null;},async getLatestSettledLeaseForTransition(){return [...leases.values()].filter(row=>row.status==='settled').at(-1)||null;},async getSlot(key){return slots.get(key)||null;},
    async insertLease(row){leases.set(row.lease_id,{...row});return leases.get(row.lease_id);},async insertSlot(row){slots.set(row.slot_key,{...row});return slots.get(row.slot_key);},async updateLease(id,patch){const row={...leases.get(id),...patch};leases.set(id,row);return row;},async settleLeaseAtomically(input){const row={...leases.get(input.lease_id),status:'settled',disposition:input.disposition,settlement_evidence:input.evidence||[],settlement_reason:input.reason||null,settlement_promotion_condition:input.promotion_condition||null,settle_idempotency_key:input.settle_idempotency_key,settled_at:input.settled_at,graph_revision_change:input.graph_revision_change||null};leases.set(input.lease_id,row);slots.delete(input.slot_key);return row;},async deleteSlot(key){slots.delete(key);},
  };
  const opKey=(command,scope,key)=>`${command}:${scope}:${key}`;
  const operationStore={
    async get(command,scope,key){return operations.get(opKey(command,scope,key))||null;},
    async claim(input){const key=opKey(input.command,input.scope,input.idempotency_key);const prior=operations.get(key);if(prior)return prior.request_sha256===input.request_sha256?{outcome:'terminal',operation:prior}:{outcome:'conflict',operation:prior};const operation={state:'prepared',...input};operations.set(key,operation);return{outcome:'claimed',operation};},
    async succeed(input){const key=opKey(input.command,input.scope,input.idempotency_key);const prior=operations.get(key);const operation={...prior,state:'succeeded',resolution:input.resolution,result_sha256:input.result_sha256,may_have_mutated:input.may_have_mutated};operations.set(key,operation);return operation;},
  };
  let counter=0;
  const readProjectGraph=async()=>({...graph,authority:{...graph.authority,definition:{...graph.authority.definition,revision:currentRevision}}});
  return{service:createPromotionAwareProjectTransitionLeaseService({store,operationStore,readProjectGraph,now:()=> '2026-09-13T12:00:00Z',uuid:()=>`00000000-0000-4000-8000-${String(++counter).padStart(12,'0')}`}),setRevision(value){currentRevision=value;}};
}

async function blocked(service,key='blocked'){
  const lease=await service.acquire({run_id:'run-1',project_ref:projectRef,transition_id:'transition-a',lease_seconds:600,idempotency_key:key});
  await service.settle({lease_ref:lease.lease_ref,run_id:'run-1',disposition:'blocked',promotion_condition:'exact verification becomes authoritative',reason:'waiting for exact verification',idempotency_key:key});
  return service.suspensionFor({project_ref:projectRef,transition_id:'transition-a'});
}

test('promotion release is exact, durable, idempotent, and removes the matching suspension',async()=>{
  const{service}=fixture();const suspension=await blocked(service);assert.ok(suspension);
  const input={project_ref:projectRef,transition_id:'transition-a',recovery_ref:suspension.recovery_ref,evidence:[{kind:'check-run',ref:'github-check:123'}],reason:'exact verification observed'};
  const first=await service.releaseSuspension(input);assert.equal(first.released,true);assert.equal(first.basis,'promotion_condition_satisfied');assert.equal(first.idempotent_replay,false);
  const replay=await service.releaseSuspension(input);assert.equal(replay.idempotent_replay,true);assert.equal(replay.basis,'promotion_condition_satisfied');
  assert.equal(await service.suspensionFor({project_ref:projectRef,transition_id:'transition-a'}),null);
});

test('promotion invalidation is a durable release basis and conflicts with a later satisfied claim',async()=>{
  const{service}=fixture();const suspension=await blocked(service);assert.ok(suspension);
  const invalidated={project_ref:projectRef,transition_id:'transition-a',recovery_ref:suspension.recovery_ref,basis:'promotion_condition_invalidated',evidence:[{kind:'check-run',ref:'github-check:failed'}],reason:'exact candidate verification failed'};
  const first=await service.releaseSuspension(invalidated);assert.equal(first.released,true);assert.equal(first.basis,'promotion_condition_invalidated');assert.equal(first.idempotent_replay,false);
  const replay=await service.releaseSuspension(invalidated);assert.equal(replay.idempotent_replay,true);assert.equal(replay.basis,'promotion_condition_invalidated');
  await assert.rejects(()=>service.releaseSuspension({...invalidated,basis:'promotion_condition_satisfied'}),{code:'PROJECT_TRANSITION_IDEMPOTENCY_CONFLICT'});
  assert.equal(await service.suspensionFor({project_ref:projectRef,transition_id:'transition-a'}),null);
});

test('promotion observation suppresses repeated verification only at the same authority revision',async()=>{
  const{service,setRevision}=fixture();const suspension=await blocked(service);assert.ok(suspension);
  const input={project_ref:projectRef,transition_id:'transition-a',recovery_ref:suspension.recovery_ref,evidence:[{kind:'github_commit_compare',ref:'github:compare:diverged'}],reason:'condition remains valid but false at this authority'};
  const first=await service.deferSuspension(input);assert.equal(first.deferred,true);assert.equal(first.authority_revision,revision);assert.equal(first.idempotent_replay,false);
  const replay=await service.deferSuspension(input);assert.equal(replay.idempotent_replay,true);
  assert.ok(await service.suspensionFor({project_ref:projectRef,transition_id:'transition-a'}));
  assert.equal(await service.promotionSuspensionFor({project_ref:projectRef,transition_id:'transition-a'}),null);
  setRevision('2'.repeat(40));
  assert.ok(await service.promotionSuspensionFor({project_ref:projectRef,transition_id:'transition-a'}));
});

test('promotion release fails closed for stale recovery identity, invalid basis, and conflicting evidence',async()=>{
  const{service}=fixture();const suspension=await blocked(service);
  await assert.rejects(()=>service.releaseSuspension({project_ref:projectRef,transition_id:'transition-a',recovery_ref:'project-transition-suspension:stale',evidence:[{kind:'check-run',ref:'github-check:123'}]}),{code:'PROJECT_TRANSITION_SUSPENSION_STALE'});
  await assert.rejects(()=>service.releaseSuspension({project_ref:projectRef,transition_id:'transition-a',recovery_ref:suspension.recovery_ref,basis:'anything',evidence:[{kind:'check-run',ref:'github-check:123'}]}),{code:'PROJECT_TRANSITION_SUSPENSION_RELEASE_INVALID'});
  await service.releaseSuspension({project_ref:projectRef,transition_id:'transition-a',recovery_ref:suspension.recovery_ref,evidence:[{kind:'check-run',ref:'github-check:123'}]});
  await assert.rejects(()=>service.releaseSuspension({project_ref:projectRef,transition_id:'transition-a',recovery_ref:suspension.recovery_ref,evidence:[{kind:'check-run',ref:'github-check:456'}]}),{code:'PROJECT_TRANSITION_IDEMPOTENCY_CONFLICT'});
});
