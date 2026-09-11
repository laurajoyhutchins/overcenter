import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const broker = await readFile(new URL('../api/gcp-semantic-command-dispatch.js', import.meta.url), 'utf8');
const relay = await readFile(new URL('../lib/gcp-semantic-project-amend-relay.js', import.meta.url), 'utf8');
const mcpAmend = await readFile(new URL('../mcp/project.amend.js', import.meta.url), 'utf8');

test('project.amend direct transport preserves target authority separately from control-plane fencing', () => {
  assert.match(broker, /PROJECT_AUTHORING_COMMANDS = new Set\(\['project\.amend'\]\)/);
  assert.match(broker, /input\.expected_revision/);
  assert.doesNotMatch(broker, /expectedRevision !== expectedHead/);

  assert.match(relay, /expected_revision:expectedRevision/);
  assert.match(relay, /x-overcenter-expected-head['"]:expectedHead/);
  assert.match(relay, /body:JSON\.stringify\(\{ command:'project\.amend', input:request\.command_input \}\)/);
  assert.doesNotMatch(relay, /dispatchGitHubWorkflowWithGitHubApp|gcp-semantic-command\.yml/);
});

test('project.amend relay authenticates directly to stateless GCP ingress with exact caller correlation', () => {
  assert.match(relay, /createGitHubAppJwtFromSecrets/);
  assert.match(relay, /https:\/\/overcenter-command-ingress-bwcce2cokq-uw\.a\.run\.app/);
  assert.match(relay, /crypto\.randomUUID\(\)/);
  assert.match(relay, /x-overcenter-request-id['"]:requestId/);
  assert.match(relay, /permissionProfile:'project_facts'/);
  assert.match(relay, /GCP_SEMANTIC_DIRECT_TRANSPORT_INDETERMINATE/);
  assert.match(relay, /may_have_mutated:true/);
  assert.doesNotMatch(relay, /fallback/i);
});

test('Hatchable project.amend is transport-only and does not consult the frozen Hatchable database', () => {
  assert.match(mcpAmend, /createGitHubAppAuth/);
  assert.match(mcpAmend, /dispatchGcpProjectAmendViaIngress/);
  assert.match(mcpAmend, /withGitHubAppApiClient:githubAppAuth\.withApiClient/);
  assert.match(mcpAmend, /secrets,/);
  assert.doesNotMatch(mcpAmend, /composeHatchableRuntimeProviders|ctx\.db|executeSemanticWorkerCommand|projectAuthoringFor|createProjectAuthoringHostRuntime/);
});
