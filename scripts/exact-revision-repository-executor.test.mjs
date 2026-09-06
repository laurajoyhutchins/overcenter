import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertExecutionRequest,
  assertExecutionResult,
  executeExactRevisionRepositoryWork,
} from './exact-revision-repository-executor.mjs';

const SHA = 'a'.repeat(40);
const FINGERPRINT = 'b'.repeat(64);

function request(overrides = {}) {
  return {
    source: { repository: 'owner/repo', revision: SHA },
    authority: {
      transition_id: 'transition',
      lease_ref: 'lease',
      transition_definition_fingerprint: FINGERPRINT,
    },
    executor: {
      identity: { provider: 'test-provider', implementation: 'fixture', fingerprint: FINGERPRINT },
      capabilities: { network: 'none', repository_write: false },
    },
    limits: { max_output_bytes: 4096, max_evidence_items: 8 },
    ...overrides,
  };
}

test('repository executor binds exact revision, lease, identity, capabilities, and bounded outputs', async () => {
  const input = assertExecutionRequest(request());
  const result = await executeExactRevisionRepositoryWork(input, {
    identity: input.executor.identity,
    capabilities: input.executor.capabilities,
    async execute(observed) {
      assert.equal(observed.source.revision, SHA);
      return { status: 'completed', summary: 'done', evidence: [{ kind: 'test', detail: 'passed' }] };
    },
  });
  assert.equal(result.status, 'completed');
});

test('provider substitution fails closed on identity or capability mismatch', async () => {
  const input = request();
  await assert.rejects(
    () => executeExactRevisionRepositoryWork(input, { identity: { ...input.executor.identity, provider: 'other' }, capabilities: input.executor.capabilities, execute: async () => ({ status: 'completed', summary: 'x', evidence: [{ kind: 'test', detail: 'x' }] }) }),
    { code: 'REPOSITORY_EXECUTOR_IDENTITY_MISMATCH' },
  );
  await assert.rejects(
    () => executeExactRevisionRepositoryWork(input, { identity: input.executor.identity, capabilities: { network: 'restricted', repository_write: false }, execute: async () => ({ status: 'completed', summary: 'x', evidence: [{ kind: 'test', detail: 'x' }] }) }),
    { code: 'REPOSITORY_EXECUTOR_CAPABILITY_MISMATCH' },
  );
});

test('revision, lease authority, repository-write isolation, and output bounds fail closed', () => {
  assert.throws(() => assertExecutionRequest(request({ source: { repository: 'owner/repo', revision: 'dev' } })), { code: 'REPOSITORY_EXECUTOR_SOURCE_REVISION_INVALID' });
  assert.throws(() => assertExecutionRequest(request({ authority: { ...request().authority, lease_ref: '' } })), { code: 'REPOSITORY_EXECUTOR_AUTHORITY_INVALID' });
  assert.throws(() => assertExecutionRequest(request({ executor: { ...request().executor, capabilities: { network: 'none', repository_write: true } } })), { code: 'REPOSITORY_EXECUTOR_REPOSITORY_WRITE_FORBIDDEN' });
  assert.throws(() => assertExecutionResult({ status: 'completed', summary: 'x'.repeat(5000), evidence: [] }, request().limits), { code: 'REPOSITORY_EXECUTOR_OUTPUT_TOO_LARGE' });
});
