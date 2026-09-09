import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const adapter = await readFile('lib/hatchable-gcp-command-adapter.js', 'utf8');
const inspect = await readFile('mcp/project.inspect.js', 'utf8');
const amend = await readFile('mcp/project.amend.js', 'utf8');
const auth = await readFile('lib/github-app-auth.js', 'utf8');

test('Hatchable GCP adapter has transport identity and configuration but no project-state provider', () => {
  assert.match(adapter, /createGcpCommandForwarder/);
  assert.match(adapter, /OVERCENTER_GCP_COMMAND_INGRESS_URL/);
  assert.match(adapter, /mintAppJwt/);
  assert.doesNotMatch(adapter, /\bdb\b/);
  assert.doesNotMatch(adapter, /composeHatchableRuntimeProviders/);
  assert.doesNotMatch(adapter, /source-authority-fence/);
});

test('project.inspect is a pure transport entrypoint with no local semantic execution', () => {
  assert.match(inspect, /createHatchableGcpCommandAdapter/);
  assert.match(inspect, /adapter\.execute\('project\.inspect'/);
  for (const forbidden of [
    'composeHatchableRuntimeProviders',
    'executeCorrelatedCommand',
    'projectInspectForGitHub',
    'createGitHubProjectGraphRuntime',
    'ctx.db',
  ]) assert.equal(inspect.includes(forbidden), false, `project.inspect still contains local authority machinery: ${forbidden}`);
});

test('read cutover is staged before mutation cutover', () => {
  assert.match(amend, /executeSemanticWorkerCommand\('project\.amend'/);
  assert.doesNotMatch(amend, /createHatchableGcpCommandAdapter/);
});

test('adapter reuses the existing GitHub App signer rather than implementing another signer', () => {
  assert.match(auth, /mintAppJwt/);
  assert.doesNotMatch(adapter, /RS256|RSA PRIVATE KEY|modPow|crypto\.subtle\.sign/);
});
