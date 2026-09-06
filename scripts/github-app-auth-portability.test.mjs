import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEnvironmentGitHubAppCredentialProvider,
  getGitHubAppIdentity,
} from '../lib/github-app-auth.js';

test('environment GitHub App credential provider reads injected environment without Hatchable config', async () => {
  const provider = createEnvironmentGitHubAppCredentialProvider({
    GITHUB_APP_ID: '4616688',
    GITHUB_APP_PRIVATE_KEY: 'private-key-value',
  });

  assert.equal(await provider.get('GITHUB_APP_ID'), '4616688');
  assert.equal(await provider.get('GITHUB_APP_PRIVATE_KEY'), 'private-key-value');
});

test('environment GitHub App credential provider fails closed on missing credential', async () => {
  const provider = createEnvironmentGitHubAppCredentialProvider({ GITHUB_APP_ID: '4616688' });

  await assert.rejects(
    () => provider.get('GITHUB_APP_PRIVATE_KEY'),
    error => error?.code === 'GITHUB_APP_SETUP_REQUIRED',
  );
});

test('getGitHubAppIdentity accepts an injected credential provider', async () => {
  const requested = [];
  const credentialProvider = {
    async get(key) {
      requested.push(key);
      if (key === 'GITHUB_APP_ID') return '4616688';
      if (key === 'GITHUB_APP_PRIVATE_KEY') return 'not-a-real-key';
      throw new Error(`unexpected ${key}`);
    },
  };

  await assert.rejects(
    () => getGitHubAppIdentity({ credentialProvider }),
    error => error?.code === 'INVALID_GITHUB_APP_PRIVATE_KEY',
  );

  assert.deepEqual(requested, ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY']);
});
