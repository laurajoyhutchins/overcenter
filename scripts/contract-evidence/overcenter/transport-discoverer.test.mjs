import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createTransportDiscoverer } from './transport-discoverer.mjs';

test('discovers current MCP input schema references without executing adapters', async () => {
  const result = await createTransportDiscoverer({ mcpRoot:'mcp', apiRoot:null }).discover({ repoRoot:process.cwd() });
  const contract = result.candidates.find((item) => item.source_identity === 'mcp:mcp/project.inspect.js#inputSchema');
  assert.ok(contract);
  assert.equal(contract.structure.input_schema.syntax, 'descriptor.input_schema');
  assert.deepEqual(contract.observed_relationships, []);
});

test('discovers static HTTP request and response boundary facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contract-http-'));
  try {
    await mkdir(join(root, 'api'), { recursive:true });
    await writeFile(join(root, 'api/sample.js'), `
export const access = 'admin';
export const methods = ['POST'];
export default async function handler(req, res) {
  const repo = req.body.repo;
  const id = req.params.id;
  const filter = req.query.filter;
  if (!repo) return res.status(400).json({ ok:false, error:'missing' });
  return res.json({ ok:true, repo:req.body.repo, id });
}
`, 'utf8');
    const result = await createTransportDiscoverer({ mcpRoot:null, apiRoot:'api' }).discover({ repoRoot:root });
    const contract = result.candidates.find((item) => item.source_identity === 'http:api/sample.js#request-response');
    assert.ok(contract);
    assert.equal(contract.structure.access, 'admin');
    assert.deepEqual(contract.structure.methods, ['POST']);
    assert.deepEqual(contract.structure.request_paths, ['body.repo', 'params.id', 'query.filter']);
    assert.deepEqual(contract.structure.response_shapes, [
      { keys:['error','ok'] },
      { keys:['id','ok','repo'] },
    ]);
  } finally {
    await rm(root, { recursive:true, force:true });
  }
});
