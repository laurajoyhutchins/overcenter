import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

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

test('project.advance worker transport composes run and advance services', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-loader',
    './scripts/hatchable-node-test-loader.mjs',
    '--input-type=module',
    '-e',
    probe,
  ], { cwd:process.cwd(), encoding:'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});