import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';
import { executeSemanticWorkerCommand } from '../lib/worker-transport.js';

const COMMANDS = ['invocation.peek', 'invocation.attach'];

test('invocation attach and peek are bounded primary semantic commands', () => {
  for (const command of COMMANDS) {
    const descriptor = semanticCommandDescriptor(command);
    assert.equal(descriptor.surface, 'primary');
    assert.deepEqual(descriptor.required_fields, ['invocation_ref']);
    assert.deepEqual(descriptor.semantic_fields, ['invocation_ref']);
    assert.equal(descriptor.exposure.worker, true);
    assert.equal(descriptor.exposure.mcp, true);
  }
});

test('worker transport delegates invocation reads through injected semantic runtime', async () => {
  const calls = [];
  const runtime = {
    invocationObservation: {
      async peek(input) {
        calls.push(['peek', input]);
        return { ok:true, schema:'invocation-observation-v1', invocation_ref:input.invocation_ref, outcome:'succeeded' };
      },
      async attach(input) {
        calls.push(['attach', input]);
        return { ok:true, schema:'invocation-attachment-v1', invocation_ref:input.invocation_ref, outcome:'running', resume_ref:'run-1' };
      },
    },
  };

  const peek = await executeSemanticWorkerCommand('invocation.peek', { invocation_ref:'inv-1' }, runtime);
  const attach = await executeSemanticWorkerCommand('invocation.attach', { invocation_ref:'inv-2' }, runtime);

  assert.equal(peek.status, 200);
  assert.equal(peek.body.invocation_ref, 'inv-1');
  assert.equal(attach.status, 200);
  assert.equal(attach.body.invocation_ref, 'inv-2');
  assert.equal(attach.body.resume_ref, 'run-1');
  assert.deepEqual(calls, [
    ['peek', { invocation_ref:'inv-1' }],
    ['attach', { invocation_ref:'inv-2' }],
  ]);
});