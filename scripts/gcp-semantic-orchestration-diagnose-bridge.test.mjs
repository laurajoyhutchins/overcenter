import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createWorkerCommandHandler } from '../lib/worker-command-handler.js';

const broker = await readFile(new URL('../api/gcp-semantic-command-dispatch.js', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../.github/workflows/gcp-semantic-command.yml', import.meta.url), 'utf8');
const descriptors = await readFile(new URL('../lib/semantic-command-descriptors.js', import.meta.url), 'utf8');
const workerTransport = await readFile(new URL('../lib/worker-transport.js', import.meta.url), 'utf8');

test('bounded GCP bridge admits orchestration.diagnose as typed diagnosis, not generic control', () => {
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

test('diagnosis bridge preserves the descriptor contract exactly', () => {
  assert.match(descriptors, /const orchestrationDiagnoseSchema = Object\.freeze\(\{[\s\S]*required: \['run_id'\][\s\S]*run_id: \{ type: 'string', minLength: 1, maxLength: 512 \}[\s\S]*work_ref: \{ type: 'string', minLength: 1, maxLength: 128 \}[\s\S]*additionalProperties: false/);
  assert.match(broker, /runId\.length > 512/);
  assert.match(broker, /workRef\.length > 128/);
});

test('GCP workflow validates and forwards only typed orchestration.diagnose input', () => {
  assert.match(workflow, /- orchestration\.diagnose/);
  assert.match(workflow, /orchestration\.diagnose\)/);
  assert.match(workflow, /orchestration\.diagnose\)[\s\S]*test -z "\$PROJECT_REF"[\s\S]*test -z "\$TRANSITION_ID"[\s\S]*test -z "\$RESUME_REF"[\s\S]*test -z "\$EXECUTION_RESULT_JSON"[\s\S]*test -n "\$command_input_json"/);
  assert.match(workflow, /keys == \["run_id"\]/);
  assert.match(workflow, /keys == \["run_id","work_ref"\]/);
  assert.match(workflow, /\.run_id \| type == "string" and length > 0 and length <= 512/);
  assert.match(workflow, /\.work_ref \| type == "string" and length > 0 and length <= 128/);
  assert.match(workflow, /^[ \t]*[^\n]*orchestration\.diagnose[^\n]*\) input="\$command_input_json"/m);
});

test('diagnosis target run identity overrides transport invocation identity at the worker boundary', async () => {
  const observed = [];
  const handler = createWorkerCommandHandler({
    commandFailure:() => ({ status:400, body:{ ok:false } }),
    executeSemanticWorkerCommand:async (command, input, runtime) => {
      observed.push({ command, input, runtime });
      return { status:200, body:{ ok:true } };
    },
    projectAuthoringFor:() => ({}),
    providers:{},
  });
  const response = { status() { return this; }, json(value) { return value; } };

  await handler({ body:{
    command:'orchestration.diagnose',
    input:{ run_id:'run-being-diagnosed' },
    invocation_context:{ run_id:'diagnosis-invocation', expected_head:'abc123' },
  } }, response);
  await handler({ body:{
    command:'project.inspect',
    input:{ project_ref:'github:laurajoyhutchins/overcenter' },
    invocation_context:{ run_id:'inspection-invocation' },
  } }, response);

  assert.equal(observed[0].input.run_id, 'run-being-diagnosed');
  assert.deepEqual(observed[0].runtime.invocationContext, { run_id:'run-being-diagnosed', expected_head:'abc123' });
  assert.deepEqual(observed[1].runtime.invocationContext, { run_id:'inspection-invocation' });
});

test('diagnosis transport delegates to the existing authoritative worker implementation', () => {
  assert.match(workerTransport, /'orchestration\.diagnose': \{/);
  assert.match(workerTransport, /createPostgresOrchestrationDiagnosisService\(\{ db:requireRuntimeDb\(runtime\), api:runtime\.api \}\)\.diagnose\(request\)/);
  assert.doesNotMatch(broker, /createPostgresOrchestrationDiagnosisService/);
  assert.doesNotMatch(workflow, /createPostgresOrchestrationDiagnosisService/);
  assert.match(workflow, /\/api\/worker-command/);
});

test('diagnosis transport remains bounded away from semantic work selection and continuation authority', () => {
  assert.doesNotMatch(broker, /PROJECT_COMMANDS = new Set\(\[[^\]]*orchestration\.diagnose/);
  assert.doesNotMatch(broker, /PROJECT_AUTHORING_COMMANDS = new Set\(\[[^\]]*orchestration\.diagnose/);
  assert.doesNotMatch(broker, /LEASE_MUTATION_COMMANDS = new Set\(\[[^\]]*orchestration\.diagnose/);
  assert.match(broker, /diagnosis commands do not accept caller-selected project or continuation state/);
});
