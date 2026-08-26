import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const libSource = await readFile('lib/portfolio-reconcile-work-surface.js', 'utf8');
const mcpSource = await readFile('mcp/portfolio_reconcile_work_surface.js', 'utf8');

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

test('MCP lane vocabulary is derived from the authoritative active lanes', () => {
  assert.match(mcpSource, /lane:\s*\{\s*type:\s*['"]string['"],\s*enum:\s*portfolioReconcileConfig\.active_lanes\s*\}/);
  const active = new Set(laneSet(libSource, 'ACTIVE_LANES'));
  const admitted = laneSet(libSource, 'NEW_ADMISSION_LANES');
  assert.deepEqual(admitted.filter((lane) => !active.has(lane)), []);
});