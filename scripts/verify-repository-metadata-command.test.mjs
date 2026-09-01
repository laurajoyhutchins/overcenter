import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CANONICAL_COMMANDS } from '../lib/canonical-commands.js';
import { normalizeGithubRepositoryMetadataRequest } from '../lib/github-repository-metadata.js';

async function source(path) {
  return readFile(path, 'utf8');
}

test('repository metadata reconciliation is a command-owned fail-closed internal capability', async () => {
  const [auth, commands, core, api] = await Promise.all([
    source('lib/github-app-auth.js'),
    source('lib/command-response.js'),
    source('lib/github-repository-metadata.js'),
    source('api/github-repository-metadata-ensure.js'),
  ]);

  assert.match(auth, /repository_metadata[\s\S]{0,220}administration:\s*["']write["'][\s\S]{0,220}fail_closed/);
  assert.equal(CANONICAL_COMMANDS.includes('github.repository_metadata.ensure'), true);
  assert.match(commands, /GITHUB_REPOSITORY_METADATA_STATE_CHANGED/);
  assert.match(commands, /GITHUB_REPOSITORY_METADATA_INDETERMINATE/);
  assert.match(core, /permissionProfile:\s*['"]repository_metadata['"]/);
  assert.match(core, /GITHUB_REPOSITORY_METADATA_STATE_CHANGED/);
  assert.match(core, /GITHUB_REPOSITORY_METADATA_INDETERMINATE/);
  assert.match(api, /github\.repository_metadata\.ensure/);
  await assert.rejects(source('mcp/github_repository_metadata_ensure.js'), /ENOENT/);
});

test('repository metadata normalization excludes identity and lifecycle mutations', () => {
  for (const forbidden of ['visibility', 'archived', 'default_branch', 'new_name', 'transfer']) {
    assert.throws(() => normalizeGithubRepositoryMetadataRequest({
      repo:'laurajoyhutchins/overcenter',
      desired_state:{ description:'Overcenter' },
      [forbidden]:true,
    }), /unsupported fields/);
  }
});