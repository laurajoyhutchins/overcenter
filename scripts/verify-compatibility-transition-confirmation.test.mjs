import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompatibilityTransitionConfirmationService } from '../lib/compatibility-transition-confirmation.js';
import { resolveCompatibilityTransitionBinding } from '../lib/compatibility-transition-bindings.js';
import { projectTransitionDefinitionFingerprint } from '../lib/project-transition-observations.js';
import { PRODUCTIVE_STAGES } from '../lib/work-lifecycle.js';

function lifecycle(done = false) {
  return { current_stage: done ? 'CONFIRM' : 'ENABLE', condition: 'NOMINAL', responsibilities: Object.fromEntries(PRODUCTIVE_STAGES.map((stage) => [stage, { applicable: true, satisfied: done }])) };
}
function graph(node) {
  return { schema:'project-graph-authority-v1', project_ref:'github:laurajoyhutchins/overcenter', authority:{definition:{kind:'github',repository:'laurajoyhutchins/overcenter',revision:'a'.repeat(40),derivation:'overcenter-project-graph-v1'},observations:[]}, nodes:[node], horizons:[] };
}

test('typed semantic binding pins the exact completed reachability unit to one transition', () => {
  assert.deepEqual(resolveCompatibilityTransitionBinding('LJH-522'), {
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'require-production-reachability',
    authority_issue:'laurajoyhutchins/overcenter#175',
  });
  assert.equal(resolveCompatibilityTransitionBinding('LJH-518'), null);
});

test('compatibility bridge consumes an existing orchestration.advance lease and requires DONE readback', async () => {
  const calls=[];
  const readyNode={id:'require-production-reachability',priority:110,requires:[],lifecycle:lifecycle(false),executor:{kind:'agent',role:'implementation',skill:'test-driven-development'},phase_bindings:{}};
  const doneNode={...readyNode,lifecycle:lifecycle(true)};
  const fingerprint=await projectTransitionDefinitionFingerprint(readyNode);
  let reads=0;
  const service=createCompatibilityTransitionConfirmationService({
    bindings:{async resolve(input){assert.equal(input.work_ref,'LJH-522');return resolveCompatibilityTransitionBinding(input.work_ref);}},
    compatibilityWork:{async requireCompleted(input){calls.push(['work',input]);return{ok:true,confirm_complete:true,settlement_ref:'941980fd-d310-4920-8e3f-1a29db47673a',evidence:[{kind:'github_actions',ref:'exact-revision-v8:33256739256:success'}]};}},
    readProjectGraph:async()=>{reads+=1;return graph(reads===1?readyNode:doneNode);},
    projectTransitions:{async require(input){calls.push(['require',input]);return{ok:true,lease_ref:'lease-1',transition_definition_fingerprint:fingerprint};},async settle(input){calls.push(['settle',input]);return{ok:true,schema:'project-transition-lease-settlement-v1',subject:'project_transition',disposition:'completed',lease_ref:'lease-1',settled_at:'2026-08-29T19:00:00Z'};}},
  });
  const result=await service.confirm({run_id:'run-bridge',work_ref:'LJH-522',lease_ref:'lease-1'});
  assert.equal(result.ok,true);
  assert.equal(result.outcome,'confirmed');
  assert.equal(calls.filter(([kind])=>kind==='require').length,1);
  assert.equal(calls.filter(([kind])=>kind==='settle').length,1);
  const required=calls.find(([kind])=>kind==='require')[1];
  assert.equal(required.transition_id,'require-production-reachability');
  assert.equal(required.project_ref,'github:laurajoyhutchins/overcenter');
  assert.equal(reads,2);
});

test('compatibility bridge fails closed before transition settlement when CONFIRM completion is absent', async () => {
  let required=false;
  const node={id:'require-production-reachability',priority:110,requires:[],lifecycle:lifecycle(false),executor:{kind:'agent',role:'implementation',skill:'test-driven-development'},phase_bindings:{}};
  const service=createCompatibilityTransitionConfirmationService({
    bindings:{async resolve(){return resolveCompatibilityTransitionBinding('LJH-522');}},
    compatibilityWork:{async requireCompleted(){return{ok:true,confirm_complete:false,settlement_ref:'not-complete',evidence:[]};}},
    readProjectGraph:async()=>graph(node),
    projectTransitions:{async require(){required=true;throw new Error('must not require');},async settle(){throw new Error('must not settle');}},
  });
  await assert.rejects(()=>service.confirm({run_id:'run-bridge',work_ref:'LJH-522',lease_ref:'lease-1'}),error=>error?.code==='COMPATIBILITY_WORK_NOT_CONFIRMED');
  assert.equal(required,false);
});

test('caller cannot select an arbitrary READY transition', async () => {
  const service=createCompatibilityTransitionConfirmationService({bindings:{async resolve(){throw new Error('must reject before binding');}},compatibilityWork:{async requireCompleted(){throw new Error('must not read work');}},readProjectGraph:async()=>({}),projectTransitions:{async settle(){throw new Error('must not settle');}}});
  await assert.rejects(()=>service.confirm({run_id:'run-bridge',work_ref:'LJH-522',lease_ref:'lease-1',transition_id:'arbitrary'}),error=>error?.code==='COMPATIBILITY_TRANSITION_CONFIRMATION_INVALID');
});