import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CANONICAL_COMMANDS } from '../lib/canonical-commands.js';
import { createOrchestrationDriveService } from '../lib/orchestration-drive.js';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';

const authority = Object.freeze({ kind:'github', repository:'owner/repo', revision:'a'.repeat(40), derivation:'test' });
const result = (outcome, extras = {}) => ({
  ok:true,
  outcome,
  run_id:'drive-test',
  project_ref:'github:owner/repo',
  frontier:[],
  authority,
  ...extras,
});

assert.ok(CANONICAL_COMMANDS.includes('orchestration.drive'), 'orchestration.drive must be registered as a canonical command');

const deterministic = [];
const deterministicService = createOrchestrationDriveService({
  max_advances:4,
  advance:async ({ run_id }) => {
    deterministic.push(run_id);
    if (deterministic.length < 3) return result('TRANSITION_CONFIRMED', { run_id, transition:{ id:`operator-${deterministic.length}`, executor:{ kind:'operator', command:'orchestration.maintain' } }, frontier:[`next-${deterministic.length}`] });
    return result('AGENT_EXECUTION_REQUIRED', { run_id, transition:{ id:'agent-work', executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }, lease_ref:'lease-ref', frontier:['agent-work'] });
  },
});
const deterministicResult = await deterministicService.drive({ run_id:'drive-test' });
assert.equal(deterministicResult.stop_class, 'AGENT_EXECUTION_REQUIRED');
assert.equal(deterministicResult.transitions_attempted, 3);
assert.equal(deterministicResult.transitions_confirmed, 2);
assert.equal(deterministicResult.deterministic_transitions_completed, 2);
assert.equal(deterministicResult.agent_boundary?.transition?.id, 'agent-work');
assert.deepEqual(deterministic, ['drive-test','drive-test','drive-test']);

for (const stopClass of ['WAITING', 'BLOCKED', 'NEEDS_DECISION', 'OFF_NOMINAL']) {
  let calls = 0;
  const service = createOrchestrationDriveService({
    advance:async () => {
      calls += 1;
      return result(stopClass);
    },
  });
  const stopped = await service.drive({ run_id:'drive-test' });
  assert.equal(stopped.stop_class, stopClass, `drive must stop at ${stopClass}`);
  assert.equal(stopped.transitions_attempted, 1);
  assert.equal(stopped.transitions_confirmed, 0);
  assert.equal(calls, 1, `${stopClass} must not be retried inside the drive loop`);
}

let boundedCalls = 0;
const bounded = createOrchestrationDriveService({
  max_advances:2,
  advance:async () => {
    boundedCalls += 1;
    return result('TRANSITION_CONFIRMED', { transition:{ id:`operator-${boundedCalls}`, executor:{ kind:'operator', command:'orchestration.maintain' } } });
  },
});
const boundedResult = await bounded.drive({ run_id:'drive-test' });
assert.equal(boundedResult.stop_class, 'ADVANCEMENT_LIMIT');
assert.equal(boundedResult.transitions_attempted, 2);
assert.equal(boundedResult.transitions_confirmed, 2);
assert.equal(boundedResult.deterministic_transitions_completed, 2);
assert.equal(boundedCalls, 2);

const noWork = createOrchestrationDriveService({ advance:async () => result('NO_PROGRESS') });
const noWorkResult = await noWork.drive({ run_id:'drive-test' });
assert.equal(noWorkResult.stop_class, 'NO_PROGRESS');
assert.equal(noWorkResult.transitions_attempted, 1);
assert.equal(noWorkResult.transitions_confirmed, 0);
assert.equal(noWorkResult.deterministic_transitions_completed, 0);

const candidateOnly = createOrchestrationDriveService({
  advance:async () => result('AGENT_EXECUTION_REQUIRED', {
    transition:{ id:'candidate-only', executor:{ kind:'agent', role:'implementation' } },
    lease_ref:'candidate-lease',
  }),
});
const candidateOnlyResult = await candidateOnly.drive({ run_id:'drive-test' });
assert.equal(candidateOnlyResult.stop_class, 'AGENT_EXECUTION_REQUIRED');
assert.equal(candidateOnlyResult.transitions_confirmed, 0, 'an executable candidate must not be counted as a confirmed transition');
assert.equal(candidateOnlyResult.deterministic_transitions_completed, 0, 'an executable candidate must not be falsely settled as deterministic work');

for (const failure of [
  Object.assign(new Error('authority moved'), { code:'PROJECT_GRAPH_REVISION_STALE', may_have_mutated:false }),
  Object.assign(new Error('effect uncertain'), { code:'PROVIDER_INDETERMINATE', may_have_mutated:true }),
]) {
  let calls = 0;
  const service = createOrchestrationDriveService({
    advance:async () => {
      calls += 1;
      throw failure;
    },
  });
  const stopped = await service.drive({ run_id:'drive-test' });
  assert.equal(stopped.stop_class, failure.may_have_mutated ? 'INDETERMINATE' : 'AUTHORITY_CHANGED');
  assert.equal(stopped.transitions_attempted, 1);
  assert.equal(stopped.transitions_confirmed, 0);
  assert.equal(stopped.unresolved?.may_have_mutated, failure.may_have_mutated);
  assert.equal(calls, 1, 'uncertain or stale authority must never be retried inside the drive loop');
}

const descriptor = semanticCommandDescriptor('orchestration.drive');
assert.equal(descriptor.command, 'orchestration.drive');
assert.equal(descriptor.surface, 'operator');
assert.deepEqual(descriptor.exposure, { worker:true, mcp:false });
assert.deepEqual(descriptor.semantic_fields, ['run_id']);
assert.deepEqual(descriptor.required_fields, ['run_id']);

const broker = await readFile(new URL('../api/gcp-semantic-command-dispatch.js', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../.github/workflows/gcp-semantic-command.yml', import.meta.url), 'utf8');
const worker = await readFile(new URL('../lib/worker-transport.js', import.meta.url), 'utf8');

assert.match(broker, /DRIVE_COMMANDS = new Set\(\['orchestration\.drive'\]\)/);
assert.match(broker, /ORCHESTRATION_DRIVE_INPUT_FIELDS = new Set\(\['run_id'\]\)/);
assert.match(broker, /normalizeOrchestrationDriveInput\(value\)/);
assert.match(broker, /orchestration\.drive input contains unknown fields/);
assert.match(broker, /orchestration\.drive run_id is required/);
assert.match(broker, /DRIVE_COMMANDS\.has\(command\)/);
assert.match(broker, /normalizeOrchestrationDriveInput\(body\.input\)/);
assert.match(broker, /expected_head must be an exact 40-character control-plane Git SHA/);

assert.match(workflow, /- orchestration\.drive/);
assert.match(workflow, /project\.inspect\|project\.advance\|project\.define\|project\.amend\|orchestration\.drive\|orchestration\.maintain/);
assert.match(workflow, /orchestration\.drive\)[\s\S]*test -z "\$PROJECT_REF"[\s\S]*test -n "\$command_input_json"[\s\S]*keys == \["run_id"\]/);
assert.match(workflow, /test "\$GITHUB_SHA" = "\$EXPECTED_HEAD"/);
assert.match(workflow, /git ls-remote origin refs\/heads\/dev/);
assert.match(workflow, /orchestration\.drive\|orchestration\.diagnose\|production\.reconcile/);
assert.match(workflow, /\/api\/worker-command/);

assert.match(worker, /createPostgresOrchestrationDriveService/);
assert.match(worker, /statusForOrchestrationDriveRuntimeError/);
assert.match(worker, /semanticCommandDescriptor\('orchestration\.drive'\)/);
assert.match(worker, /'orchestration\.drive': \{/);
assert.match(worker, /createPostgresOrchestrationDriveService\([^)]*\)\.drive\(request\)/s);
assert.match(worker, /executeCorrelatedCommand/);
assert.doesNotMatch(broker, /while\s*\([\s\S]*project\.advance/);
assert.doesNotMatch(workflow, /while\s*\([\s\S]*project\.advance/);
