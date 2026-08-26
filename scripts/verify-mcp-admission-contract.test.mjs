import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const libSource = await readFile('lib/portfolio-reconcile-work-surface.js', 'utf8');
const mcpSource = await readFile('mcp/portfolio_reconcile_work_surface.js', 'utf8');
const horizonMcpSource = await readFile('mcp/orchestration.horizon_checkpoint.js', 'utf8');
const horizonApiSource = await readFile('api/orchestration/horizon-checkpoint.js', 'utf8');
const finishMcpSource = await readFile('mcp/orchestration.finish.js', 'utf8');
const finishApiSource = await readFile('api/orchestration/finish.js', 'utf8');

function laneStrings(source) {
  return [...source.matchAll(/['"](lane:[^'"]+)['"]/g)].map((match) => match[1]);
}

function laneSet(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(match, `${name} declaration was not found`);
  return [...new Set(laneStrings(match[1]))].sort();
}

function semanticCanonicalizer(source, command) {
  const match = source.match(/import\s+\{\s*(canonical[A-Za-z0-9]+Command)\s*\}\s+from\s+['"]lib\/operator-commands\.js['"]/);
  assert.ok(match, `${command} MCP contract does not declare a semantic canonicalizer`);
  return match[1];
}

function assertHttpAdapterUsesMcpCanonicalizer(command, mcpContract, httpAdapter) {
  const canonicalizer = semanticCanonicalizer(mcpContract, command);
  assert.match(httpAdapter, new RegExp(`\\b${canonicalizer}\\b`), `${command} HTTP adapter does not import the MCP canonicalizer ${canonicalizer}`);
  assert.match(
    httpAdapter,
    new RegExp(`\\b${canonicalizer}\\s*\\(\\s*req\\.body\\s*\\|\\|\\s*\\{\\s*\\}\\s*\\)`),
    `${command} HTTP adapter does not canonicalize the caller request before execution`,
  );
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

test('HTTP orchestration adapters preserve MCP semantic canonicalization', () => {
  assertHttpAdapterUsesMcpCanonicalizer('orchestration.horizon_checkpoint', horizonMcpSource, horizonApiSource);
  assertHttpAdapterUsesMcpCanonicalizer('orchestration.finish', finishMcpSource, finishApiSource);
});