import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSemanticWorkerCommand } from '../lib/worker-transport.js';

test('project.advance worker transport composes run and advance services', async () => {
  const starts = [];
  const advances = [];
  const response = await executeSemanticWorkerCommand('project.advance', {
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'make-project-advance-self-contained',
  }, {
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

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body?.ok, true);
  assert.equal(starts.length, 1);
  assert.equal(advances.length, 1);
  assert.equal(advances[0].run_id, starts[0].run_id);
  assert.equal(response.body?.resume_ref, starts[0].run_id);
});