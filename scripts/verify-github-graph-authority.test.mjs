import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mcpSource = await readFile('mcp/github_apply_changeset.js', 'utf8');

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

const contract = loadMcpContract(mcpSource);
const request = {
  repo: 'laurajoyhutchins/overcenter',
  base_sha: 'a'.repeat(40),
  branch: 'feat/example',
  expected_head: 'a'.repeat(40),
  changes: [{ path: 'example.txt', operation: 'create', content: 'example\n' }],
  commit_message: 'Example',
};

test('github.apply_changeset discovery requires one non-secret lease_ref', () => {
  assert.equal(contract.inputSchema.required.includes('lease_ref'), true);
  assert.equal(contract.inputSchema.required.includes('lease_token'), false);
  assert.equal('lease_ref' in contract.inputSchema.properties, true);
  assert.equal('lease_token' in contract.inputSchema.properties, false);
  assert.equal(schemaAccepts(contract.inputSchema, { ...request, lease_ref: '11111111-1111-4111-8111-111111111111' }), true);
  assert.equal(schemaAccepts(contract.inputSchema, { ...request, lease_token: 'secret-capability' }), false);
});

test('github.apply_changeset MCP resolves execution authority internally from lease_ref', () => {
  assert.match(mcpSource, /createPostgresExecutionAuthorityService/);
  assert.match(mcpSource, /lease_ref/);
  assert.match(mcpSource, /authority\.require/);
});