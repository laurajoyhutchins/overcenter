import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectAdvancePromotionRuntime } from '../lib/project-advance-promotion-runtime.js';

const projectRef='github:laurajoyhutchins/overcenter';

test('untargeted WAITING advances surface the first suspended frontier transition for promotion verification',async()=>{
  const calls=[];
  const runtime=createProjectAdvancePromotionRuntime({
    host:{async advance(input){calls.push(['advance',input]);return{ok:true,outcome:'WAITING',frontier:['ready-without-suspension','blocked-transition'],resume_ref:'resume-1'};}},
    projectTransitions:{
      async suspensionFor({transition_id}){calls.push(['suspensionFor',transition_id]);return transition_id==='blocked-transition'?{recovery_ref:'project-transition-suspension:lease-1',blocked_lease_ref:'lease-1',authority_revision:'1'.repeat(40),conditions:{promotion_condition:'exact evidence exists',transition_revision_fingerprint:'rev-fp',transition_dependency_fingerprint:'dep-fp'}}:null;},
      async releaseSuspension(){throw new Error('release should not run before agent verification');},
    },
  });
  const result=await runtime.advance({project_ref:projectRef});
  assert.equal(result.outcome,'AGENT_EXECUTION_REQUIRED');
  assert.equal(result.operation,'project_transition.verify_promotion');
  assert.equal(result.transition_id,'blocked-transition');
  assert.equal(result.resume_ref,'resume-1');
  assert.equal(result.promotion.recovery_ref,'project-transition-suspension:lease-1');
  assert.deepEqual(result.promotion.required_result.dispositions,['completed','requeue']);
  assert.deepEqual(calls,[['advance',{project_ref:projectRef}],['suspensionFor','ready-without-suspension'],['suspensionFor','blocked-transition']]);
});

test('targeted WAITING promotion packets retain the target transition identity',async()=>{
  const runtime=createProjectAdvancePromotionRuntime({
    host:{async advance(){return{ok:true,outcome:'WAITING',frontier:['blocked-transition'],resume_ref:'resume-2'};}},
    projectTransitions:{
      async suspensionFor(){return{recovery_ref:'project-transition-suspension:lease-2',blocked_lease_ref:'lease-2',conditions:{promotion_condition:'proof required'}};},
      async releaseSuspension(){throw new Error('release should not run before agent verification');},
    },
  });
  const result=await runtime.advance({project_ref:projectRef,transition_id:'blocked-transition'});
  assert.equal(result.outcome,'AGENT_EXECUTION_REQUIRED');
  assert.equal(result.transition_id,'blocked-transition');
});

test('negative promotion verification requeues the transition while resuming the durable run by its original target identity',async()=>{
  const calls=[];
  const runtime=createProjectAdvancePromotionRuntime({
    host:{async advance(input){calls.push(['advance',input]);return{ok:true,outcome:'AGENT_EXECUTION_REQUIRED',transition_id:'blocked-transition'};}},
    projectTransitions:{
      async suspensionFor(){return{recovery_ref:'project-transition-suspension:lease-3',blocked_lease_ref:'lease-3',conditions:{promotion_condition:'candidate exact verification passes'}};},
      async releaseSuspension(input){calls.push(['release',input]);return{ok:true,released:true,basis:input.basis};},
    },
  });
  const result=await runtime.advance({
    project_ref:projectRef,
    transition_id:'blocked-transition',
    resume_ref:'resume-3',
    execution_result:{
      disposition:'requeue',
      evidence:[{kind:'github_check',ref:'github:check-run:failed-candidate'}],
      reason:'The exact candidate failed its required verification and must be re-executed against current authority.',
    },
  });
  assert.equal(calls[0][0],'release');
  assert.equal(calls[0][1].basis,'promotion_condition_invalidated');
  assert.equal(result.promotion_release.basis,'promotion_condition_invalidated');
  assert.deepEqual(calls[1],['advance',{project_ref:projectRef,resume_ref:'resume-3'}]);
});

test('unsupported promotion verification dispositions fail closed before release',async()=>{
  let released=false;
  const runtime=createProjectAdvancePromotionRuntime({
    host:{async advance(){throw new Error('host should not resume');}},
    projectTransitions:{
      async suspensionFor(){return{recovery_ref:'project-transition-suspension:lease-4',blocked_lease_ref:'lease-4',conditions:{promotion_condition:'proof required'}};},
      async releaseSuspension(){released=true;},
    },
  });
  await assert.rejects(()=>runtime.advance({project_ref:projectRef,transition_id:'blocked-transition',resume_ref:'resume-4',execution_result:{disposition:'blocked',evidence:[{kind:'fact',ref:'x'}],reason:'still waiting'}}),{code:'PROJECT_TRANSITION_PROMOTION_RESULT_INVALID'});
  assert.equal(released,false);
});
