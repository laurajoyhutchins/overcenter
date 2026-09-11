import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const broker = await readFile(new URL('../api/gcp-semantic-command-dispatch.js', import.meta.url), 'utf8');
const relay = await readFile(new URL('../lib/gcp-semantic-project-amend-relay.js', import.meta.url), 'utf8');
const adapter = await readFile(new URL('../lib/hatchable-gcp-ingress-adapter.js', import.meta.url), 'utf8');
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

test('Hatchable project.amend binds only credentials at the explicit ingress adapter and never a database', () => {
  assert.match(adapter, /from 'hatchable'/);
  assert.match(adapter, /createGitHubAppAuth/);
  assert.doesNotMatch(adapter, /\bdb\b|composeHatchableRuntimeProviders|source-authority-fence/);

  assert.match(mcpAmend, /composeHatchableGcpIngressAdapter/);
  assert.match(mcpAmend, /dispatchGcpProjectAmendViaIngress/);
  assert.match(mcpAmend, /providers\.githubAppAuth\.withApiClient/);
  assert.match(mcpAmend, /secrets:providers\.secrets/);
  assert.doesNotMatch(mcpAmend, /from ['"]hatchable['"]|ctx\.db|executeSemanticWorkerCommand|projectAuthoringFor|createProjectAuthoringHostRuntime/);
});
