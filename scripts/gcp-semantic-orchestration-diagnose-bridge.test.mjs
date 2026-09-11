import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const broker = await readFile(new URL('../api/gcp-semantic-command-dispatch.js', import.meta.url), 'utf8');
const descriptors = await readFile(new URL('../lib/semantic-command-descriptors.js', import.meta.url), 'utf8');
const workerTransport = await readFile(new URL('../lib/worker-transport.js', import.meta.url), 'utf8');

test('bounded GCP transport admits orchestration.diagnose as typed diagnosis, not generic control', () => {
  assert.match(broker, /DIAGNOSIS_COMMANDS = new Set\(\['orchestration\.diagnose'\]\)/);
  assert.match(broker, /ORCHESTRATION_DIAGNOSE_INPUT_FIELDS = new Set\(\['run_id', 'work_ref'\]\)/);
  assert.match(broker, /normalizeOrchestrationDiagnoseInput\(value\)/);
  assert.match(broker, /orchestration\.diagnose input contains unknown fields/);
  assert.match(broker, /orchestration\.diagnose run_id is required/);
  assert.match(broker, /orchestration\.diagnose run_id is too large/);
  assert.match(broker, /orchestration\.diagnose work_ref is too large/);
  assert.doesNotMatch(broker, /CONTROL_COMMANDS = new Set\(\[[^\]]*orchestration\.diagnose/);
  assert.match(broker, /DIAGNOSIS_COMMANDS\.has\(command\)/);
  assert.match(broker, /normalizeOrchestrationDiagnoseInput\(body\.input\)/);
});

test('diagnosis transport preserves the descriptor contract exactly', () => {
  assert.match(descriptors, /const orchestrationDiagnoseSchema = Object\.freeze\(\{[\s\S]*required: \['run_id'\][\s\S]*run_id: \{ type: 'string', minLength: 1, maxLength: 512 \}[\s\S]*work_ref: \{ type: 'string', minLength: 1, maxLength: 128 \}[\s\S]*additionalProperties: false/);
  assert.match(broker, /runId\.length > 512/);
  assert.match(broker, /workRef\.length > 128/);
});

test('direct GCP transport forwards typed orchestration.diagnose input without workflow choreography', () => {
  assert.match(broker, /return \{ command: request\.command, input: JSON\.parse\(request\.command_input_json\) \};/);
  assert.match(broker, /Authorization:\s*`Bearer \$\{appJwt\}`/);
  assert.match(broker, /['"]x-overcenter-expected-head['"]:\s*request\.expected_head/);
  assert.match(broker, /body:\s*JSON\.stringify\(commandBody\)/);
  assert.doesNotMatch(broker, /dispatchGitHubWorkflowWithGitHubApp|gcp-semantic-command\.yml|workflow_run_id/);
});

test('diagnosis transport delegates semantics to the existing authoritative worker implementation', () => {
  assert.match(workerTransport, /'orchestration\.diagnose': \{/);
  assert.match(workerTransport, /createPostgresOrchestrationDiagnosisService\(\{ db:requireRuntimeDb\(runtime\), api:runtime\.api \}\)\.diagnose\(request\)/);
  assert.doesNotMatch(broker, /createPostgresOrchestrationDiagnosisService/);
});

test('diagnosis transport remains bounded away from semantic work selection and continuation authority', () => {
  assert.doesNotMatch(broker, /PROJECT_COMMANDS = new Set\(\[[^\]]*orchestration\.diagnose/);
  assert.doesNotMatch(broker, /PROJECT_AUTHORING_COMMANDS = new Set\(\[[^\]]*orchestration\.diagnose/);
  assert.doesNotMatch(broker, /LEASE_MUTATION_COMMANDS = new Set\(\[[^\]]*orchestration\.diagnose/);
  assert.match(broker, /diagnosis commands do not accept caller-selected project or continuation state/);
});
