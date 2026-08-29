import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import './verify-release-command.test.mjs';
import './verify-release-behavior.test.mjs';

const libSource = await readFile('lib/portfolio-reconcile-work-surface.js', 'utf8');
const mcpSource = await readFile('mcp/portfolio_reconcile_work_surface.js', 'utf8');
const horizonMcpSource = await readFile('mcp/orchestration.horizon_checkpoint.js', 'utf8');
const horizonApiSource = await readFile('api/orchestration/horizon-checkpoint.js', 'utf8');
const finishMcpSource = await readFile('mcp/orchestration.finish.js', 'utf8');
const finishApiSource = await readFile('api/orchestration/finish.js', 'utf8');
const startMcpSource = await readFile('mcp/orchestration.start.js', 'utf8');

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

function loadMcpContract(source) {
  const executable = source
    .replace(/^import .*$/gm, '')
    .replace('export const access', 'const access')
    .replace('export default {', 'const contract = {');
  return Function(`${executable}\nreturn contract;`)();
}

function schemaAccepts(schema, value) {
  if (!schema) return true;
  if (schema.not && schemaAccepts(schema.not, value)) return false;
  if (schema.allOf && !schema.allOf.every((candidate) => schemaAccepts(candidate, value))) return false;
  if (schema.anyOf && !schema.anyOf.some((candidate) => schemaAccepts(candidate, value))) return false;
  if (schema.oneOf && schema.oneOf.filter((candidate) => schemaAccepts(candidate, value)).length !== 1) return false;
  if (schema.required && (!value || typeof value !== 'object' || schema.required.some((key) => !(key in value)))) return false;
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!allowed.includes(actual)) return false;
  }
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) return false;
    if (schema.maxLength != null && value.length > schema.maxLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) return false;
    if (schema.maxItems != null && value.length > schema.maxItems) return false;
    if (schema.items && !value.every((item) => schemaAccepts(schema.items, item))) return false;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in schema.properties))) return false;
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (key in value && !schemaAccepts(childSchema, value[key])) return false;
    }
  }
  return true;
}

const startScopeSchema = loadMcpContract(startMcpSource).inputSchema.properties.scope;

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

test('orchestration.start discovery requires exactly one runtime authority anchor', () => {
  assert.equal(schemaAccepts(startScopeSchema, { repositories: ['laurajoyhutchins/overcenter'] }), false);
  assert.equal(schemaAccepts(startScopeSchema, { project: 'Overcenter', repositories: ['laurajoyhutchins/overcenter'] }), true);
  assert.equal(schemaAccepts(startScopeSchema, { team: 'Ljh-projects', projects: ['Overcenter'], repositories: ['laurajoyhutchins/overcenter'] }), true);
  assert.equal(schemaAccepts(startScopeSchema, { project: 'Overcenter', team: 'Ljh-projects' }), false);
  assert.equal(schemaAccepts(startScopeSchema, { project: 'Overcenter', projects: ['Overcenter'] }), false);
  assert.equal(schemaAccepts(startScopeSchema, { project: '   ' }), false);
  assert.equal(schemaAccepts(startScopeSchema, { team: '   ' }), false);
});