import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CANONICAL_COMMANDS } from '../lib/command-response.js';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('milestone ensure is a canonical command with narrow GitHub App permission', async () => {
  const auth = await source('lib/github-app-auth.js');
  assert.equal(CANONICAL_COMMANDS.includes('github.milestone.ensure'), true);
  assert.match(auth, /milestone:\s*Object\.freeze\(\{\s*permissions:\s*Object\.freeze\(\{\s*pull_requests:\s*["']write["'],\s*metadata:\s*["']read["']/s);
});

test('milestone due_on is optional but never nullable', async () => {
  const domain = await source('lib/github-milestone.js');
  const dueOnFunction = domain.match(/function normalizeDueOn\(value\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(dueOnFunction, /function normalizeDueOn/);
  assert.doesNotMatch(dueOnFunction, /value === null/);
  assert.match(dueOnFunction, /due_on must be an RFC3339 timestamp/);
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