import test from 'node:test';
import assert from 'node:assert/strict';

import { createProjectAuthoringRecoveryService } from '../lib/project-authoring-recovery.js';

const BASE='1111111111111111111111111111111111111111';
const HEAD='2222222222222222222222222222222222222222';
const REQUEST=Object.freeze({
  project_ref:'github:acme/demo',
  expected_revision:BASE,
  amendment:{ upsert_transitions:[{ id:'next', requires:[] }] },
});

function waitingOperation(overrides={}) {
  return {
    command:'project.amend',
    idempotency_scope:'project:github:acme/demo',
    idempotency_key:'project-amend-v1:'+'a'.repeat(64),
    request_sha256:'b'.repeat(64),
    state:'prepared',
    may_have_mutated:true,
    recovery_payload:{
      attempt_token:'attempt-1',
      phase:'WAITING_EXTERNAL_VERIFICATION',
      command:'project.amend',
      request:REQUEST,
      project_ref:REQUEST.project_ref,
      expected_revision:BASE,
      staged_revision:HEAD,
      pull_request:17,
      waiting_predicates:{ verification:'pending' },
      last_reconciliation:{ outcome:'waiting' },
    },
    resolution:null,
    ...overrides,
  };
}

function pendingError() {
  const error=new Error('waiting for exact-head verification');
  error.code='PROJECT_AUTHORING_INTEGRATION_PENDING';
  error.may_have_mutated=true;
  error.details={
    repository:'acme/demo',
    base:'dev',
    head:'overcenter/project-amend/demo',
    staged_revision:HEAD,
    integration:{
      ok:true,
      outcome:'waiting',
      pull_request:17,
      verification:{ state:'pending', required:['verify'] },
    },
  };
  return error;
}

function serviceHarness({ existing=null, pending=[], executeAuthoring }={}) {
  const calls=[];
  const operations={
    async get(){ return existing; },
    async claim(input){ calls.push(['claim',input]); return { outcome:'claimed', operation:{ ...waitingOperation({ may_have_mutated:false }), recovery_payload:{ attempt_token:input.attempt_token, phase:'EXECUTING' } } }; },
    async pausePrepared(input){ calls.push(['pausePrepared',input]); return waitingOperation({ recovery_payload:{ ...input.recovery_payload, attempt_token:input.attempt_token }, may_have_mutated:input.may_have_mutated }); },
    async resumePrepared(input){ calls.push(['resumePrepared',input]); return waitingOperation({ recovery_payload:{ ...waitingOperation().recovery_payload, attempt_token:input.attempt_token, phase:'RECONCILING' } }); },
    async markIndeterminate(input){ calls.push(['markIndeterminate',input]); return waitingOperation({ state:'indeterminate', recovery_payload:{ ...input.recovery_payload, attempt_token:input.attempt_token } }); },
    async succeed(input){ calls.push(['succeed',input]); return { ...waitingOperation(), state:'succeeded', recovery_payload:null, resolution:input.resolution }; },
    async abandon(input){ calls.push(['abandon',input]); return true; },
  };
  const service=createProjectAuthoringRecoveryService({
    operations,
    listPending:async()=>pending,
    executeAuthoring:executeAuthoring || (async()=>({ ok:true, authority:{ revision:HEAD } })),
    now:()=> '2026-09-05T22:30:00.000Z',
    newAttemptToken:()=> 'attempt-2',
  });
  return { service, calls };
}

test('known pending exact-head verification is durably represented without becoming indeterminate', async()=>{
  const { service, calls }=serviceHarness({ executeAuthoring:async()=>{ throw pendingError(); } });
  await assert.rejects(()=>service.execute('project.amend',REQUEST),(error)=>error.code==='PROJECT_AUTHORING_INTEGRATION_PENDING');
  const pause=calls.find(([name])=>name==='pausePrepared')?.[1];
  assert.ok(pause,'pending work must be persisted');
  assert.equal(pause.may_have_mutated,true);
  assert.equal(pause.recovery_payload.phase,'WAITING_EXTERNAL_VERIFICATION');
  assert.equal(pause.recovery_payload.command,'project.amend');
  assert.deepEqual(pause.recovery_payload.request,REQUEST);
  assert.equal(pause.recovery_payload.project_ref,REQUEST.project_ref);
  assert.equal(pause.recovery_payload.expected_revision,BASE);
  assert.equal(pause.recovery_payload.staged_revision,HEAD);
  assert.equal(pause.recovery_payload.pull_request,17);
  assert.deepEqual(pause.recovery_payload.waiting_predicates,{ verification:'pending' });
  assert.equal(calls.some(([name])=>name==='markIndeterminate'),false);
});

test('maintenance resumes waiting authoring and settles the same operation without caller replay', async()=>{
  const pending=[waitingOperation()];
  let executions=0;
  const result={ ok:true, schema:'project-authoring-result-v1', authority:{ revision:'3333333333333333333333333333333333333333' } };
  const { service, calls }=serviceHarness({ pending, executeAuthoring:async(command,input)=>{ executions+=1; assert.equal(command,'project.amend'); assert.deepEqual(input,REQUEST); return result; } });
  const maintenance=await service.maintain(10);
  assert.equal(executions,1);
  assert.equal(maintenance.length,1);
  assert.equal(maintenance[0].kind,'project_authoring_reconciliation');
  assert.equal(maintenance[0].outcome,'succeeded');
  const resume=calls.find(([name])=>name==='resumePrepared')?.[1];
  assert.equal(resume.prior_attempt_token,'attempt-1');
  assert.equal(resume.attempt_token,'attempt-2');
  const success=calls.find(([name])=>name==='succeed')?.[1];
  assert.deepEqual(success.resolution.result,result);
});

test('authority movement during recovery is fail-closed and never abandons the staged candidate', async()=>{
  const stale=new Error('authority moved'); stale.code='PROJECT_AUTHORING_AUTHORITY_STALE'; stale.may_have_mutated=false; stale.details={ observed_revision:'4'.repeat(40) };
  const { service, calls }=serviceHarness({ pending:[waitingOperation()], executeAuthoring:async()=>{ throw stale; } });
  const maintenance=await service.maintain(10);
  assert.equal(maintenance[0].outcome,'recompute_required');
  const pause=calls.filter(([name])=>name==='pausePrepared').at(-1)?.[1];
  assert.equal(pause.recovery_payload.phase,'RECOMPUTE_REQUIRED');
  assert.equal(pause.may_have_mutated,true);
  assert.equal(calls.some(([name])=>name==='abandon'),false);
});

test('uncertain integration transport becomes indeterminate instead of being blindly replayed', async()=>{
  const uncertain=new Error('merge transport uncertain'); uncertain.code='GITHUB_INTEGRATION_INDETERMINATE'; uncertain.may_have_mutated=true;
  const { service, calls }=serviceHarness({ pending:[waitingOperation()], executeAuthoring:async()=>{ throw uncertain; } });
  const maintenance=await service.maintain(10);
  assert.equal(maintenance[0].outcome,'indeterminate');
  assert.equal(calls.some(([name])=>name==='markIndeterminate'),true);
});

test('exact replay returns the terminal durable result without re-executing authoring', async()=>{
  const result={ ok:true, schema:'project-authoring-result-v1', authority:{ revision:'5'.repeat(40) } };
  let executions=0;
  const { service }=serviceHarness({ existing:waitingOperation({ state:'succeeded', recovery_payload:null, resolution:{ result } }), executeAuthoring:async()=>{ executions+=1; throw new Error('must not execute'); } });
  assert.deepEqual(await service.execute('project.amend',REQUEST),result);
  assert.equal(executions,0);
});