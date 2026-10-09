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
  dispatchSourceValidation(
    'fixture',
    'acme/widget',
    '.github/workflows/overcenter-candidate.yml',
    publication,
    'b'.repeat(40),
    (token, path, body) => {
      calls.push({ token, path, body });
      return 204;
    },
  );
  assert.deepEqual(calls, [
    {
      token: 'fixture',
      path: '/repos/acme/widget/actions/workflows/overcenter-candidate.yml/dispatches',
      body: {
        ref: 'overcenter/candidate/run-id',
        inputs: { candidate_sha: 'a'.repeat(40), runtime_sha: 'b'.repeat(40) },
      },
    },
  ]);
  assert.throws(
    () =>
      dispatchSourceValidation(
        'fixture',
        'acme/widget',
        '.github/workflows/nested/evil.yml',
        publication,
        'b'.repeat(40),
        () => 204,
      ),
    /SOURCE_VALIDATION_WORKFLOW_INVALID/,
  );
  assert.throws(
    () =>
      dispatchSourceValidation(
        'fixture',
        'acme/widget',
        '.github/workflows/overcenter-candidate.yml',
        { ...publication, ref: 'refs/heads/main' },
        'b'.repeat(40),
        () => 204,
      ),
    /SOURCE_VALIDATION_REF_INVALID/,
  );
  assert.throws(
    () =>
      dispatchSourceValidation(
        'fixture',
        'acme/widget',
        '.github/workflows/overcenter-candidate.yml',
        { ...publication, candidate_sha: 'not-a-sha' },
        'b'.repeat(40),
        () => 204,
      ),
    /SOURCE_VALIDATION_CANDIDATE_INVALID/,
  );
  assert.throws(
    () =>
      dispatchSourceValidation(
        'fixture',
        'acme/widget',
        '.github/workflows/overcenter-candidate.yml',
        publication,
        'not-a-sha',
        () => 204,
      ),
    /SOURCE_VALIDATION_RUNTIME_INVALID/,
  );
  assert.throws(
    () =>
      dispatchSourceValidation(
        'fixture',
        'acme/widget',
        '.github/workflows/overcenter-candidate.yml',
        publication,
        'b'.repeat(40),
        () => 500,
      ),
    /SOURCE_VALIDATION_DISPATCH_FAILED/,
  );
});
