import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const libSource = await readFile('lib/portfolio-reconcile-work-surface.js', 'utf8');
const mcpSource = await readFile('mcp/portfolio_reconcile_work_surface.js', 'utf8');

function laneStrings(source) {
  return [...source.matchAll(/['"](lane:[^'"]+)['"]/g)].map((match) => match[1]);
}

function newAdmissionLanes(source) {
  const match = source.match(/const\s+NEW_ADMISSION_LANES\s*=\s*new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match, 'NEW_ADMISSION_LANES declaration was not found');
  return [...new Set(laneStrings(match[1]))].sort();
}

function mcpLaneVocabulary(source) {
  const match = source.match(/lane:\s*\{\s*type:\s*['"]string['"],\s*enum:\s*\[([\s\S]*?)\]\s*\}/);
  assert.ok(match, 'portfolio_reconcile_work_surface MCP lane enum was not found');
  return [...new Set(laneStrings(match[1]))].sort();
}

test('new work admission remains Enable-only', () => {
  assert.deepEqual(newAdmissionLanes(libSource), ['lane:enable']);
});

test('MCP lane vocabulary includes every authoritative new-work admission lane', () => {
  const admitted = newAdmissionLanes(libSource);
  const exposed = new Set(mcpLaneVocabulary(mcpSource));
  assert.deepEqual(admitted.filter((lane) => !exposed.has(lane)), []);
});