import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { verifyExactRevisionV8 } from './exact-revision-v8-verification.mjs';

const revision = 'a'.repeat(40);
const desiredContent = "export const access = 'public';\n";
const desiredHash = createHash('sha256').update(desiredContent).digest('hex');

test('materializes one exact revision and returns attributed V8 evidence', async () => {
  const calls = [];
  const result = await verifyExactRevisionV8(
    { repository: 'laurajoyhutchins/overcenter', revision, verification_project: 'verification-slot' },
    {
      source: { observe: async input => { calls.push(['source.observe', input]); return { revision, files: [{ path: 'api/example.js', content: desiredContent, sha256: desiredHash }] }; } },
      runtime: {
        inspect: async project => { calls.push(['runtime.inspect', project]); return { project, version: 7, files: [{ path: 'api/stale.js', sha256: 'b'.repeat(64) }] }; },
        reconcile: async input => { calls.push(['runtime.reconcile', input]); assert.deepEqual(input.writes, [{ path: 'api/example.js', content: desiredContent }]); assert.deepEqual(input.deletes, ['api/stale.js']); },
        deploy: async input => { calls.push(['runtime.deploy', input]); return { version: 8 }; },
        inspectDeployment: async input => { calls.push(['runtime.inspectDeployment', input]); return { version: 8, files: [{ path: 'api/example.js', sha256: desiredHash }] }; },
        runRegressions: async input => { calls.push(['runtime.runRegressions', input]); return { ok: true, passed: 683, failed: 0 }; },
      },
    },
  );
  assert.equal(result.schema, 'exact-revision-verification-v1');
});

test('rejects a deployment whose source hash differs from the requested revision', async () => {
  await assert.rejects(
    verifyExactRevisionV8(
      { repository: 'laurajoyhutchins/overcenter', revision, verification_project: 'verification-slot' },
      {
        source: { observe: async () => ({ revision, files: [{ path: 'api/example.js', content: desiredContent, sha256: desiredHash }] }) },
        runtime: {
          inspect: async () => ({ project: 'verification-slot', version: 7, files: [] }),
          reconcile: async () => {},
          deploy: async () => ({ version: 8 }),
          inspectDeployment: async () => ({ version: 8, files: [{ path: 'api/example.js', sha256: 'c'.repeat(64) }] }),
          runRegressions: async () => ({ ok: true, passed: 683, failed: 0 }),
        },
      },
    ),
    error => error?.code === 'SOURCE_MATERIALIZATION_MISMATCH',
  );
});

test('rejects moving refs before touching the verification runtime', async () => {
  let touched = false;
  await assert.rejects(
    verifyExactRevisionV8(
      { repository: 'laurajoyhutchins/overcenter', revision: 'main', verification_project: 'verification-slot' },
      {
        source: { observe: async () => { touched = true; return { revision: 'main', files: [] }; } },
        runtime: {},
      },
    ),
    error => error?.code === 'INVALID_REVISION',
  );
  assert.equal(touched, false);
});

test('rejects a deployment version that is not the immediate successor', async () => {
  await assert.rejects(
    verifyExactRevisionV8(
      { repository: 'laurajoyhutchins/overcenter', revision, verification_project: 'verification-slot' },
      {
        source: { observe: async () => ({ revision, files: [] }) },
        runtime: {
          inspect: async () => ({ project: 'verification-slot', version: 7, files: [] }),
          reconcile: async () => {},
          deploy: async () => ({ version: 9 }),
          inspectDeployment: async () => ({ version: 9, files: [] }),
          runRegressions: async () => ({ ok: true, passed: 683, failed: 0 }),
        },
      },
    ),
    error => error?.code === 'DEPLOYMENT_VERSION_MISMATCH',
  );
});

test('rejects non-green canonical V8 regressions', async () => {
  await assert.rejects(
    verifyExactRevisionV8(
      { repository: 'laurajoyhutchins/overcenter', revision, verification_project: 'verification-slot' },
      {
        source: { observe: async () => ({ revision, files: [] }) },
        runtime: {
          inspect: async () => ({ project: 'verification-slot', version: 7, files: [] }),
          reconcile: async () => {},
          deploy: async () => ({ version: 8 }),
          inspectDeployment: async () => ({ version: 8, files: [] }),
          runRegressions: async () => ({ ok: false, passed: 682, failed: 1 }),
        },
      },
    ),
    error => error?.code === 'V8_REGRESSION_FAILED',
  );
});
