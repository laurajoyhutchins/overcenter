import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import './verify-release-command.test.mjs';
import './verify-release-behavior.test.mjs';

const libSource = await readFile('lib/portfolio-reconcile-work-surface.js', 'utf8');
const horizonApiSource = await readFile('api/orchestration/horizon-checkpoint.js', 'utf8');
const finishApiSource = await readFile('api/orchestration/finish.js', 'utf8');
const startApiSource = await readFile('api/orchestration/start.js', 'utf8');
const runSource = await readFile('lib/orchestration-runs.js', 'utf8');

function laneStrings(source) {
  return [...source.matchAll(/['"](lane:[^'"]+)['"]/g)].map((match) => match[1]);
}

function laneSet(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(match, `${name} declaration was not found`);
  return [...new Set(laneStrings(match[1]))].sort();
}

test('new work admission remains Enable-only', () => {
  assert.deepEqual(laneSet(libSource, 'NEW_ADMISSION_LANES'), ['lane:enable']);
});

test('internal work admission vocabulary remains derived from authoritative active lanes', () => {
  const active = new Set(laneSet(libSource, 'ACTIVE_LANES'));
  const admitted = laneSet(libSource, 'NEW_ADMISSION_LANES');
  assert.deepEqual(admitted.filter((lane) => !active.has(lane)), []);
});

test('internal HTTP orchestration adapters preserve semantic canonicalization without MCP wrappers', () => {
  assert.match(horizonApiSource, /canonicalHorizonCommand/);
  assert.match(horizonApiSource, /canonicalHorizonCommand\(req\.body\|\|\{\}\)/);
  assert.match(finishApiSource, /canonicalFinishCommand/);
  assert.match(finishApiSource, /canonicalFinishCommand\(req\.body\|\|\{\}\)/);
});

test('orchestration.start authority anchoring remains enforced in the runtime rather than MCP discovery', () => {
  assert.match(startApiSource, /createPostgresTargetAwareOrchestrationRunService/);
  assert.match(runSource, /legacy scope\.project cannot be combined with scope\.team or scope\.projects/);
  assert.match(runSource, /scope\.team is required when scope\.project is omitted/);
});