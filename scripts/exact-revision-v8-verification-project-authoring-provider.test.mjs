import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectAuthoringGitHubAppProvider } from '../lib/project-authoring-overcenter-host.js';

test('hosted project authoring resolves the injected GitHub App provider explicitly', async () => {
  const nestedCalls = [];
  const githubAppAuth = {
    marker:'nested-auth',
    async withApiClient(...args) {
      nestedCalls.push({ self:this, args });
      return 'nested-result';
    },
  };
  const nestedProvider = resolveProjectAuthoringGitHubAppProvider({ githubAppAuth });
  assert.equal(await nestedProvider('example/project', 'callback'), 'nested-result');
  assert.equal(nestedCalls.length, 1);
  assert.equal(nestedCalls[0].self, githubAppAuth);
  assert.deepEqual(nestedCalls[0].args, ['example/project', 'callback']);

  const directProvider = async () => 'direct-result';
  assert.equal(resolveProjectAuthoringGitHubAppProvider({ withGitHubAppApiClient:directProvider }), directProvider);

  assert.throws(
    () => resolveProjectAuthoringGitHubAppProvider({}),
    (error) => error?.code === 'RUNTIME_PROVIDER_MISSING' && error?.details?.provider === 'githubAppAuth',
  );
});
