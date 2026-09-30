import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchSourceValidation } from '../src/source/validation-dispatch.ts';

test('validation dispatch is limited to published candidate branches and never implies settlement', () => {
  const publication = {
    state: 'PUBLISHED' as const,
    ref: 'refs/heads/overcenter/candidate/run-id',
    candidate_sha: 'a'.repeat(40),
  };
  const calls: unknown[] = [];
  dispatchSourceValidation('fixture', 'acme/widget', publication, (token, path, body) => {
    calls.push({ token, path, body });
    return 204;
  });
  assert.deepEqual(calls, [
    {
      token: 'fixture',
      path: '/repos/acme/widget/actions/workflows/agent-candidate-signal.yml/dispatches',
      body: { ref: 'overcenter/candidate/run-id' },
    },
  ]);
  assert.throws(
    () =>
      dispatchSourceValidation(
        'fixture',
        'acme/widget',
        { ...publication, ref: 'refs/heads/main' },
        () => 204,
      ),
    /SOURCE_VALIDATION_REF_INVALID/,
  );
  assert.throws(
    () => dispatchSourceValidation('fixture', 'acme/widget', publication, () => 500),
    /SOURCE_VALIDATION_DISPATCH_FAILED/,
  );
});
