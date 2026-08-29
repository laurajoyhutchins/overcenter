import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompatibilityTransitionConfirmationService } from '../lib/compatibility-transition-confirmation.js';

test('compatibility bridge emits one ordinary project-transition settlement for the exact bound work unit', async () => {
  const calls = [];
  const service = createCompatibilityTransitionConfirmationService({
    bindings: { async resolve(input) { assert.equal(input.work_ref, 'LJH-REACHABILITY'); return { project_ref:'github:laurajoyhutchins/overcenter', transition_id:'require-production-reachability', authority_issue:'laurajoyhutchins/overcenter#175' }; } },
    compatibilityWork: { async requireCompleted(input) { calls.push(['work', input]); return { ok:true, confirm_complete:true, evidence:[{kind:'production_verification',ref:'run-1'}] }; } },
    readProjectGraph: async () => ({ schema:'project-graph-authority-v1', project_ref:'github:laurajoyhutchins/overcenter', authority:{definition:{kind:'github',repository:'laurajoyhutchins/overcenter',revision:'a'.repeat(40),derivation:'overcenter-project-graph-v1'},observations:[]}, nodes:[{id:'require-production-reachability',priority:110,requires:[],lifecycle:{current_stage:'ENABLE',responsibilities:{}},executor:{kind:'agent',role:'implementation',skill:'test-driven-development'},phase_bindings:{}}], horizons:[] }),
    projectTransitions: { async acquire(input){calls.push(['acquire',input]);return{ok:true,lease_ref:'lease-1',transition_definition_fingerprint:'f'.repeat(64)};}, async settle(input){calls.push(['settle',input]);return{ok:true,schema:'project-transition-lease-settlement-v1',subject:'project_transition',disposition:'completed',lease_ref:'lease-1',settled_at:'2026-08-29T19:00:00Z'};} },
  });
  const result = await service.confirm({run_id:'run-bridge',work_ref:'LJH-REACHABILITY'});
  assert.equal(result.ok,true);
  assert.equal(calls.filter(([kind])=>kind==='acquire').length,1);
  assert.equal(calls.filter(([kind])=>kind==='settle').length,1);
  assert.equal(calls.find(([kind])=>kind==='acquire')[1].transition_id,'require-production-reachability');
});

test('caller cannot select an arbitrary READY transition', async () => {
  const service=createCompatibilityTransitionConfirmationService({ bindings:{async resolve(){return{project_ref:'github:laurajoyhutchins/overcenter',transition_id:'require-production-reachability',authority_issue:'laurajoyhutchins/overcenter#175'};}}, compatibilityWork:{async requireCompleted(){return{ok:true,confirm_complete:true,evidence:[{kind:'production_verification',ref:'run-1'}]};}}, readProjectGraph:async()=>({schema:'project-graph-authority-v1',project_ref:'github:laurajoyhutchins/overcenter',authority:{definition:{kind:'github',repository:'laurajoyhutchins/overcenter',revision:'a'.repeat(40),derivation:'overcenter-project-graph-v1'},observations:[]},nodes:[],horizons:[]}), projectTransitions:{async acquire(){throw new Error('must not acquire');},async settle(){throw new Error('must not settle');}} });
  await assert.rejects(()=>service.confirm({run_id:'run-bridge',work_ref:'LJH-REACHABILITY',transition_id:'arbitrary'}),error=>error?.code==='COMPATIBILITY_TRANSITION_CONFIRMATION_INVALID');
});