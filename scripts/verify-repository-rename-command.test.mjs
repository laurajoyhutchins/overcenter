import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CANONICAL_COMMANDS } from '../lib/canonical-commands.js';

async function source(path) {
  return readFile(path, 'utf8');
}

test('repository rename is a permanent verified command-owned capability', async () => {
  assert.equal(CANONICAL_COMMANDS.includes('github.repository.rename'), true);

  const [auth, commands, core, api] = await Promise.all([
    source('lib/github-app-auth.js'),
    source('lib/command-response.js'),
    source('lib/github-repository-rename.js'),
    source('api/github-repository-rename.js'),
  ]);

  assert.match(auth, /repository_metadata[\s\S]{0,220}administration:\s*["']write["'][\s\S]{0,220}fail_closed/);
  assert.match(commands, /GITHUB_REPOSITORY_IDENTITY_CHANGED/);
  assert.match(commands, /GITHUB_REPOSITORY_RENAME_INDETERMINATE/);
  assert.match(core, /permissionProfile:\s*['"]repository_metadata['"]/);
  assert.match(core, /expected_repository_id/);
  assert.match(core, /reconciled_after_indeterminate_write/);
  assert.match(core, /already_renamed/);
  assert.match(api, /github\.repository\.rename/);
});

test('repository rename request owns only old coordinate, new name, and immutable identity precondition', async () => {
  const core = await source('lib/github-repository-rename.js');
  assert.match(core, /new Set\(\['repo', 'new_name', 'expected_repository_id'\]\)/);
  for (const forbidden of ['transfer', 'visibility', 'archived', 'default_branch', 'owner']) {
    assert.equal(core.includes(`'${forbidden}'`) || core.includes(`"${forbidden}"`), false, `rename command admitted ${forbidden}`);
  }
});

// Behavioral rename semantics run in the Hatchable-backed runtime regression registry.
