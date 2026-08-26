import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('milestone ensure is a canonical command with narrow GitHub App permission', async () => {
  const [commandResponse, auth] = await Promise.all([
    source('lib/command-response.js'),
    source('lib/github-app-auth.js'),
  ]);
  assert.match(commandResponse, /'github\.milestone\.ensure'/);
  assert.match(auth, /milestone:\s*Object\.freeze\(\{\s*permissions:\s*Object\.freeze\(\{\s*pull_requests:\s*["']write["'],\s*metadata:\s*["']read["']/s);
});

test('milestone ensure has domain implementation, MCP tool, API adapter, journal projection, and registered regression suite', async () => {
  const [domain, mcp, api, journal, registry] = await Promise.all([
    source('lib/github-milestone.js'),
    source('mcp/github_milestone_ensure.js'),
    source('api/github-milestone-ensure.js'),
    source('lib/orchestration-journal.js'),
    source('lib/regression-suite-registry.js'),
  ]);
  assert.match(domain, /ensureGithubMilestoneWithGitHubApp/);
  assert.match(mcp, /name:\s*['"]github_milestone_ensure['"]/);
  assert.match(mcp, /['"]github\.milestone\.ensure['"]/);
  assert.match(api, /['"]github\.milestone\.ensure['"]/);
  assert.match(journal, /command === ['"]github\.milestone\.ensure['"]/);
  assert.match(registry, /lib\/github-milestone\.test\.js/);
});
