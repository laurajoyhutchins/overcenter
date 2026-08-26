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
    {
      repository: 'laurajoyhutchins/overcenter',
      revision,
      verification_project: 'verification-slot',
    },
    {
      source: {
        observe: async input => {
          calls.push(['source.observe', input]);
          return {
            revision,
            files: [{ path: 'api/example.js', content: desiredContent, sha256: desiredHash }],
          };
        },
      },
      runtime: {
        inspect: async project => {
          calls.push(['runtime.inspect', project]);
          return {
            project,
            version: 7,
            files: [{ path: 'api/stale.js', sha256: 'b'.repeat(64) }],
          };
        },
        reconcile: async input => {
          calls.push(['runtime.reconcile', input]);
          assert.deepEqual(input.writes, [{ path: 'api/example.js', content: desiredContent }]);
          assert.deepEqual(input.deletes, ['api/stale.js']);
        },
        deploy: async input => {
          calls.push(['runtime.deploy', input]);
          return { version: 8 };
        },
        inspectDeployment: async input => {
          calls.push(['runtime.inspectDeployment', input]);
          return {
            version: 8,
            files: [{ path: 'api/example.js', sha256: desiredHash }],
          };
        },
        runRegressions: async input => {
          calls.push(['runtime.runRegressions', input]);
          return { ok: true, passed: 683, failed: 0 };
        },
      },
    },
  );

  assert.equal(result.schema, 'exact-revision-verification-v1');
  assert.equal(result.repository, 'laurajoyhutchins/overcenter');
  assert.equal(result.revision, revision);
  assert.equal(result.runtime.project, 'verification-slot');
  assert.equal(result.runtime.deployment_version, 8);
  assert.deepEqual(result.regression, { ok: true, passed: 683, failed: 0 });
  assert.deepEqual(calls.map(([name]) => name), [
    'source.observe',
    'runtime.inspect',
    'runtime.reconcile',
    'runtime.deploy',
    'runtime.inspectDeployment',
    'runtime.runRegressions',
  ]);
});
