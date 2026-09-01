import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const probe = `
import { executeCorrelatedCommand } from './lib/orchestration-journal.js';
import { createWorkerCommandHandler } from './lib/worker-command-handler.js';
import { validateSemanticWorkerCommand } from './lib/worker-transport.js';

const repo = 'laurajoyhutchins/overcenter';
const runId = 'project-advance-invocation-context-test';
const starts = [];
const finishes = [];
const domainRequests = [];
const journal = {
  async start(request) {
    starts.push(request);
    return { invocation_id:'11111111-1111-4111-8111-111111111111', sequence:7 };
  },
  async finish(invocationId, body, activity) {
    finishes.push({ invocationId, body, activity });
  },
};

const correlated = await executeCorrelatedCommand(
  'production.promote',
  { repo },
  async (request) => {
    domainRequests.push(request);
    return { ok:true, repo };
  },
  {
    invocationContext:{ run_id:runId },
    journal,
    db:{ async query() { throw new Error('injected journal should avoid database access'); } },
  },
);
if (correlated.status !== 200 || correlated.body?.ok !== true) throw new Error('correlated command failed');
if (starts.length !== 1) throw new Error('invocation context did not start one journal invocation');
if (starts[0].run_id !== runId) throw new Error('journal did not use invocation-context run_id');
if (starts[0].command !== 'production.promote') throw new Error('journal lost command identity');
if (domainRequests.length !== 1 || JSON.stringify(domainRequests[0]) !== JSON.stringify({ repo })) {
  throw new Error('invocation context leaked into production.promote semantic request');
}
if (finishes.length !== 1 || finishes[0].activity?.run_id !== runId) throw new Error('journal finish lost invocation-context run_id');

let semanticRejected = false;
try { validateSemanticWorkerCommand('production.promote', { repo, run_id:runId }); }
catch (error) { semanticRejected = error?.code === 'REQUEST_INVALID'; }
if (!semanticRejected) throw new Error('production.promote accepted run_id as semantic input');

const observed = [];
const handler = createWorkerCommandHandler({
  db:{},
  commandFailure() { throw new Error('commandFailure should not run'); },
  projectAuthoringFor() { throw new Error('project authoring should not run'); },
  async executeSemanticWorkerCommand(command, input, runtime) {
    observed.push({ command, input, runtime });
    return { status:200, body:{ ok:true } };
  },
  logger:{ warn() {} },
});
let status = null;
let responseBody = null;
await handler(
  { body:{ command:'production.promote', input:{ repo }, invocation_context:{ run_id:runId } } },
  { status(value) { status=value; return this; }, json(value) { responseBody=value; return value; } },
);
if (status !== 200 || responseBody?.ok !== true) throw new Error('worker handler failed');
if (observed.length !== 1) throw new Error('worker handler did not execute semantic command once');
if (JSON.stringify(observed[0].input) !== JSON.stringify({ repo })) throw new Error('worker handler changed semantic input');
if (observed[0].runtime?.invocationContext?.run_id !== runId) throw new Error('worker handler did not pass invocation_context separately');
`;

test('production.promote correlation comes from invocation context, not semantic input', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-loader',
    './scripts/hatchable-node-test-loader.mjs',
    '--input-type=module',
    '-e',
    probe,
  ], { cwd:process.cwd(), encoding:'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});