import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const probe = `
import { executeSemanticWorkerCommand } from './lib/worker-transport.js';
const starts = [];
const advances = [];
const response = await executeSemanticWorkerCommand('project.advance', {
  project_ref:'github:laurajoyhutchins/overcenter',
  transition_id:'make-project-advance-self-contained',
}, {
  db:{ async query() { return { rows:[] }; } },
  orchestrationRuns:{
    async start(request) {
      starts.push(request);
      return { run_id:request.run_id };
    },
  },
  orchestrationAdvance:{
    async advance(request) {
      advances.push(request);
      return {
        ok:true,
        schema:'orchestration-advance-v1',
        outcome:'AGENT_EXECUTION_REQUIRED',
        run_id:request.run_id,
      };
    },
  },
  logger:{ error() {} },
});
if (response.status !== 200 || response.body?.ok !== true) {
  throw new Error(JSON.stringify(response.body));
}
if (starts.length !== 1 || advances.length !== 1) throw new Error('project.advance did not compose both services');
if (advances[0].run_id !== starts[0].run_id) throw new Error('project.advance changed run identity between services');
if (response.body?.resume_ref !== starts[0].run_id) throw new Error('project.advance did not return its durable resume_ref');
`;

const completionProbe = `
import { executeSemanticWorkerCommand } from './lib/worker-transport.js';
const starts = [];
const advances = [];
const finishes = [];
const existingRunId = 'project-advance-existing';
const projectRef = 'github:laurajoyhutchins/overcenter';
const transitionId = 'enforce-primary-mcp-discovery-boundary';
const response = await executeSemanticWorkerCommand('project.advance', {
  project_ref:projectRef,
  transition_id:transitionId,
  resume_ref:existingRunId,
  execution_result:{ disposition:'completed' },
}, {
  db:{
    async query(sql) {
      if (String(sql).includes('SELECT run_id,status,target')) {
        return { rows:[{
          run_id:existingRunId,
          status:'active',
          target:{ project_ref:projectRef, horizon:{ kind:'transition', ref:transitionId } },
        }] };
      }
      return { rows:[] };
    },
  },
  orchestrationRuns:{
    async start(request) {
      starts.push(request);
      return { run_id:request.run_id };
    },
  },
  orchestrationAdvance:{
    async advance(request) {
      advances.push(request);
      return {
        ok:true,
        schema:'orchestration-advance-v1',
        outcome:'TARGET_COMPLETE',
        run_id:request.run_id,
      };
    },
  },
  orchestrationFinish:{
    async finish(request) {
      finishes.push(request);
      return { status:'finished', run_id:request.run_id };
    },
  },
  logger:{ error() {} },
});
if (response.status !== 200 || response.body?.ok !== true) {
  throw new Error(JSON.stringify(response.body));
}
if (finishes.length !== 1) throw new Error('project.advance did not settle and finish the resumed execution internally');
if (finishes[0].run_id !== existingRunId) throw new Error('project.advance finished the wrong resumed run');
if (finishes[0].active_lease_settlement?.disposition !== 'completed') throw new Error('project.advance did not preserve the agent execution disposition');
if (starts.length !== 0) throw new Error('project.advance started a fresh run after terminal execution settlement');
if (advances.length !== 0) throw new Error('project.advance advanced into unrelated READY work after terminal execution settlement');
if (response.body?.run_id !== existingRunId || response.body?.status !== 'finished') throw new Error('project.advance did not return the terminal settlement result');
if (response.body?.resume_ref != null) throw new Error('project.advance returned a resume_ref after terminal execution settlement');
`;

const diagnosticProbe = `
import { executeSemanticWorkerCommand } from './lib/worker-transport.js';
const logs = [];
const response = await executeSemanticWorkerCommand('project.advance', {
  project_ref:'github:laurajoyhutchins/overcenter',
  transition_id:'finish-hatchable-gcp-authoritative-state-migration',
}, {
  db:{ async query() { return { rows:[] }; } },
  projectAdvance:{
    async advance() {
      const error = new Error('sensitive provider failure body must not cross the worker boundary');
      error.code = 'RUNTIME_PROVIDER_UNAVAILABLE';
      error.details = { provider:'api', secret:'must-not-leak', may_have_mutated:false };
      throw error;
    },
  },
  logger:{ error(message) { logs.push(message); } },
});
if (response.status !== 500) throw new Error('internal project.advance failure did not remain a 500');
if (response.body?.error_code !== 'PROJECT_ADVANCE_ERROR') throw new Error('public semantic error code changed');
if (response.body?.details?.diagnostic_error_code !== 'RUNTIME_PROVIDER_UNAVAILABLE') throw new Error('stable diagnostic error code was lost');
if (response.body?.details?.diagnostic_failure_kind !== 'runtime_provider') throw new Error('diagnostic failure kind was lost');
if (response.body?.may_have_mutated !== false) throw new Error('mutation certainty changed');
const serialized = JSON.stringify(response.body);
if (serialized.includes('sensitive provider failure body') || serialized.includes('must-not-leak')) throw new Error('raw internal details crossed the worker boundary');
if (!logs.some((entry) => entry.includes('RUNTIME_PROVIDER_UNAVAILABLE'))) throw new Error('structured internal log lost the original code');
`;

const databaseDiagnosticProbe = `
import { executeSemanticWorkerCommand } from './lib/worker-transport.js';
const response = await executeSemanticWorkerCommand('project.advance', {
  project_ref:'github:laurajoyhutchins/overcenter',
  transition_id:'finish-hatchable-gcp-authoritative-state-migration',
}, {
  db:{ async query() { return { rows:[] }; } },
  projectAdvance:{
    async advance() {
      const error = new Error('database connection terminated unexpectedly');
      error.code = '08006';
      throw error;
    },
  },
  logger:{ error() {} },
});
if (response.status !== 500) throw new Error('database project.advance failure did not remain a 500');
if (response.body?.error_code !== 'PROJECT_ADVANCE_ERROR') throw new Error('public semantic error code changed');
if (response.body?.details?.diagnostic_error_code !== '08006') throw new Error('database SQLSTATE diagnostic was lost');
if (response.body?.details?.diagnostic_failure_kind !== 'database_infrastructure') throw new Error('database infrastructure classification was lost');
if (response.body?.may_have_mutated !== true) throw new Error('unannotated database failure was incorrectly declared non-mutating');
if (response.body?.details?.may_have_mutated !== true) throw new Error('database mutation uncertainty was not preserved in diagnostic details');
if (response.body?.details?.recovery_allowed !== false) throw new Error('database infrastructure failure unexpectedly allowed automatic recovery');
`;

function runProbe(source) {
  return spawnSync(process.execPath, [
    '--experimental-loader',
    './scripts/hatchable-node-test-loader.mjs',
    '--input-type=module',
    '-e',
    source,
  ], { cwd:process.cwd(), encoding:'utf8' });
}

test('project.advance worker transport composes run and advance services', () => {
  const result = runProbe(probe);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('project.advance execution completion terminates through the same semantic boundary', () => {
  const result = runProbe(completionProbe);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('project.advance internal failures preserve safe machine diagnostics without raw details', () => {
  const result = runProbe(diagnosticProbe);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('project.advance unannotated database failures preserve mutation uncertainty', () => {
  const result = runProbe(databaseDiagnosticProbe);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('project.advance primary MCP transport composes execution completion runtime', async () => {
  const source = await readFile(new URL('../mcp/project.advance.js', import.meta.url), 'utf8');
  assert.match(source, /createPostgresSubjectAwareOrchestrationRunService/);
  assert.match(source, /const finish = createPostgresSubjectAwareOrchestrationRunService\(runtime\);/);
  assert.match(source, /const authoritativeEffect = createPostgresProjectTransitionAuthoritativeEffectConfirmationService\(runtime\);/);
  assert.match(source, /confirmAuthoritativeEffect:\(request\) => authoritativeEffect\.confirm\(request\)/);
});
