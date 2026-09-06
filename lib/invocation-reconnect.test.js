import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvocationReconnectService } from 'lib/invocation-reconnect.js';

test('invocation attach returns an authoritative reconnect reference without session reconstruction', async () => {
  const service=createInvocationReconnectService({
    store:{
      async invocationById(id){
        assert.equal(id,'inv-7');
        return { invocation_id:id, run_id:'run-3', sequence:7, command:'github.apply_changeset', outcome:'running', started_at:'2026-09-06T02:00:00.000Z', completed_at:null, may_have_mutated:false };
      },
    },
  });
  const result=await service.attach({ invocation_ref:'invocation:inv-7' });
  assert.deepEqual(result,{ ok:true, schema:'invocation-attachment-v1', invocation_ref:'invocation:inv-7', run_ref:'run:run-3', state:'running', reconnect_ref:'invocation:inv-7' });
});

test('invocation peek reads bounded authoritative execution state and fails closed for an unknown invocation', async () => {
  const service=createInvocationReconnectService({
    store:{
      async invocationById(id){
        if(id==='missing') return null;
        return { invocation_id:id, run_id:'run-3', sequence:7, command:'github.apply_changeset', target_kind:'github_repository', target_ref:'laurajoyhutchins/overcenter', outcome:'indeterminate', error_code:'UPSTREAM_AMBIGUOUS', started_at:'2026-09-06T02:00:00.000Z', completed_at:'2026-09-06T02:00:01.000Z', may_have_mutated:true };
      },
    },
  });
  const peek=await service.peek({ invocation_ref:'invocation:inv-7' });
  assert.equal(peek.schema,'invocation-peek-v1');
  assert.equal(peek.invocation_ref,'invocation:inv-7');
  assert.equal(peek.run_ref,'run:run-3');
  assert.equal(peek.command,'github.apply_changeset');
  assert.equal(peek.outcome,'indeterminate');
  assert.equal(peek.mutation_certainty,'unknown');
  await assert.rejects(()=>service.peek({invocation_ref:'invocation:missing'}),error=>error?.code==='INVOCATION_NOT_FOUND');
});

test('reconnect contract accepts only opaque invocation references', async () => {
  const service=createInvocationReconnectService({store:{async invocationById(){throw new Error('store must not be reached');}}});
  await assert.rejects(()=>service.attach({invocation_ref:'inv-7'}),error=>error?.code==='REQUEST_INVALID');
  await assert.rejects(()=>service.peek({invocation_ref:'run:run-3'}),error=>error?.code==='REQUEST_INVALID');
});