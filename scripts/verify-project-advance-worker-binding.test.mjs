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
if (starts.length !== 1 || advances.length !== 1) throw new Error('project.advance did not restart from fresh authority after completion');
if (response.body?.resume_ref !== starts[0].run_id) throw new Error('project.advance did not return the fresh continuation after completion');
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

test('project.advance accepts agent execution completion and resumes through the same semantic boundary', () => {
  const result = runProbe(completionProbe);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('project.advance primary MCP transport composes execution completion runtime', async () => {
  const source = await readFile(new URL('../mcp/project.advance.js', import.meta.url), 'utf8');
  assert.match(source, /createPostgresSubjectAwareOrchestrationRunService/);
  assert.match(source, /const finish = createPostgresSubjectAwareOrchestrationRunService\(\{ db \}\);/);
  assert.match(source, /projectAdvanceFor\(\{ db, runs, advance, finish \}\)/);
});
