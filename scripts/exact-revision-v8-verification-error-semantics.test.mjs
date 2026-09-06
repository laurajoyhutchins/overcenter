import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const commandResponseUrl = new URL('../lib/command-response.js', import.meta.url);
const orchestrationFailuresUrl = new URL('../lib/orchestration-failures.js', import.meta.url);

test('missing project graph reader is setup-required without disabling the worker', async () => {
  const [commandResponse, orchestrationFailures] = await Promise.all([
    readFile(commandResponseUrl, 'utf8'),
    readFile(orchestrationFailuresUrl, 'utf8'),
  ]);

  assert.match(commandResponse, /PROJECT_GRAPH_READER_UNAVAILABLE/);
  assert.match(commandResponse, /restore_runtime_capability/);
  assert.match(orchestrationFailures, /RUNTIME_SETUP_REQUIRED/);
  assert.match(orchestrationFailures, /PROJECT_GRAPH_READER_UNAVAILABLE/);
  assert.match(
    orchestrationFailures,
    /failure_state === 'RUNTIME_SETUP_REQUIRED'\) return 'degraded'/,
  );
  assert.doesNotMatch(
    orchestrationFailures,
    /DISABLED_CODES[\s\S]*PROJECT_GRAPH_READER_UNAVAILABLE[\s\S]*AUTHORITY_CONFLICT_CODES/,
  );
});

test('text replacement precondition failure stays typed and locally recoverable at the semantic worker boundary', async () => {
  const { mkdir, symlink, writeFile } = await import('node:fs/promises');
  await mkdir('node_modules/hatchable', { recursive:true });
  await writeFile('node_modules/hatchable/package.json', JSON.stringify({ type:'module', exports:'./index.js' }));
  await writeFile('node_modules/hatchable/index.js', `
export const api = {};
export const db = {};
export const config = {};
export const run = {};
export const agent = {};
export const tasks = {};
export const scheduler = {};
export const storage = {};
export const email = {};
export const ai = {};
export const browser = {};
export const knowledge = {};
export const memory = {};
export const cache = {};
export const auth = {};
export const approval = {};
`);
  try { await symlink('../lib', 'node_modules/lib', 'dir'); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const { executeSemanticWorkerCommand } = await import('../lib/worker-transport.js');
  const failure = new Error('replacement precondition failed for lib/example.js');
  failure.code = 'TEXT_PRECONDITION_FAILED';
  failure.httpStatus = 422;
  failure.may_have_mutated = false;
  failure.details = {
    path:'lib/example.js',
    replacement_index:0,
    expected_count:1,
    actual_count:2,
  };

  const response = await executeSemanticWorkerCommand('github.apply_text_replacements', {
    lease_ref:'lease-test',
    replacements:[{
      path:'lib/example.js',
      old:'const value = 1;',
      new_text:'const value = 2;',
      expected_count:1,
    }],
    commit_message:'test: exact replacement',
  }, {
    githubMutations:{
      applyChangeset:async () => { throw new Error('applyChangeset must not run'); },
      applyTextReplacements:async () => { throw failure; },
    },
  });

  assert.equal(response.status, 422);
  assert.equal(response.body.error, 'TEXT_PRECONDITION_FAILED');
  assert.equal(response.body.error_class, 'precondition');
  assert.equal(response.body.rejection, true);
  assert.equal(response.body.may_have_mutated, false);
  assert.equal(response.body.path, 'lib/example.js');
  assert.equal(response.body.replacement_index, 0);
  assert.equal(response.body.expected_count, 1);
  assert.equal(response.body.actual_count, 2);
  assert.equal(response.body.failure_state, 'REQUEST_PRECONDITION_CHANGED');
  assert.equal(response.body.automatic_recovery_allowed, false);
  assert.equal(response.body.escalation_required, false);
  assert.equal(response.body.recommended_action, 'execute_recovery_operation');
  assert.deepEqual(response.body.recovery_operation, {
    command:'github.apply_text_replacements',
    mode:'reread_exact_workspace_text_and_recompute_request',
    use_original_request:false,
    requires:['exact_workspace_text', 'corrected_replacement_precondition'],
  });
});