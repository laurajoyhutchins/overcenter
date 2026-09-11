import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const broker = await readFile(new URL('../api/gcp-semantic-command-dispatch.js', import.meta.url), 'utf8');
const githubAuth = await readFile(new URL('../lib/github-app-auth.js', import.meta.url), 'utf8');

test('Hatchable semantic broker invokes the stateless GCP ingress directly', () => {
  assert.match(githubAuth, /export async function createGitHubAppJwtFromSecrets/);
  assert.match(broker, /createGitHubAppJwtFromSecrets/);
  assert.doesNotMatch(broker, /dispatchGitHubWorkflowWithGitHubApp/);
  assert.doesNotMatch(broker, /gcp-semantic-command\.yml/);
  assert.match(broker, /https:\/\/overcenter-command-ingress-bwcce2cokq-uw\.a\.run\.app/);
  assert.match(broker, /Authorization:\s*`Bearer \$\{appJwt\}`/);
  assert.match(broker, /['"]x-overcenter-request-id['"]:\s*requestId/);
});

test('direct broker preserves exact-head fencing and caller correlation', () => {
  assert.match(broker, /['"]x-overcenter-expected-head['"]:\s*request\.expected_head/);
  assert.match(broker, /request_id:\s*requestId/);
  assert.match(broker, /crypto\.randomUUID\(\)/);
});

test('direct broker returns the authoritative semantic response instead of a workflow receipt', () => {
  assert.match(broker, /await response\.text\(\)/);
  assert.match(broker, /res\.status\(response\.status\)/);
  assert.doesNotMatch(broker, /workflow_run_id/);
  assert.doesNotMatch(broker, /workflow_run_head_sha/);
});

test('ambiguous direct transport failure fails closed as potentially mutating', () => {
  assert.match(broker, /GCP_SEMANTIC_DIRECT_TRANSPORT_INDETERMINATE/);
  assert.match(broker, /may_have_mutated:\s*true/);
  assert.doesNotMatch(broker, /fallback/i);
});
