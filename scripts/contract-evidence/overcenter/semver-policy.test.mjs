import assert from 'node:assert/strict';
import test from 'node:test';
import { readOvercenterSemverKinds } from './semver-policy.mjs';

test('reads public and internal SemVer compatibility kinds from the existing policy source', async () => {
  const kinds = await readOvercenterSemverKinds('src/semantic/semver-public-api.ts');
  for (const kind of [
    'semantic-command',
    'semantic-command-contract',
    'project-definition-schema',
    'project-horizon-schema',
    'public-evidence-schema',
    'external-error-semantics',
    'lifecycle-semantics',
    'internal-module-layout',
    'database-layout',
    'runtime-host-detail',
    'adapter-layout',
    'behavior-preserving-refactor',
  ]) {
    assert.equal(kinds.has(kind), true, kind);
  }
  assert.equal(kinds.has('invented-contract-kind'), false);
});
