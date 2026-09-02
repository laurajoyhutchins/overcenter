import assert from 'node:assert/strict';
import test from 'node:test';

function fixtureCatalog() {
  return {
    schema:'contract-evidence-catalog-v1',
    repository:{ root:'.' },
    candidates:[
      {
        source_identity:'mcp:project.advance#inputSchema',
        source_kind:'mcp',
        source_location:{ path:'mcp/project.advance.js', anchor:'inputSchema' },
        symbol_or_boundary:'inputSchema',
        structural_fingerprint:'b'.repeat(64),
        observed_relationships:[],
      },
      {
        source_identity:'semantic-command:project.advance#input',
        source_kind:'semantic-command',
        source_location:{ path:'src/semantic/semantic-command-descriptors.ts', anchor:'project.advance' },
        symbol_or_boundary:'project.advance',
        structural_fingerprint:'a'.repeat(64),
        observed_relationships:[],
      },
    ],
    logical_contracts:[{
      id:'project.advance.input',
      authority:{
        source_identity:'semantic-command:project.advance#input',
        source_kind:'semantic-command',
        significance:'public',
        structural_fingerprint:'a'.repeat(64),
        semver_kind:'semantic-command',
      },
      projections:[{
        source_identity:'mcp:project.advance#inputSchema',
        source_kind:'mcp',
        structural_fingerprint:'b'.repeat(64),
      }],
    }],
    unclassified_source_identities:[],
    summary:{ discovered:2, classified:2, unclassified:0, logical_contracts:1 },
  };
}

test('contract-evidence package renders a deterministic logical-contract authority atlas', async () => {
  const api = await import('../../packages/contract-evidence/index.mjs');
  assert.equal(typeof api.renderAuthorityAtlasMarkdown, 'function');

  const first = api.renderAuthorityAtlasMarkdown(fixtureCatalog());
  const second = api.renderAuthorityAtlasMarkdown(fixtureCatalog());
  assert.equal(first, second);
  assert.match(first, /^# Contract authority atlas/m);
  assert.match(first, /## `project\.advance\.input`/);
  assert.match(first, /Significance: `public`/);
  assert.match(first, /SemVer: `semantic-command`/);
  assert.match(first, /Authority: `semantic-command:project\.advance#input`/);
  assert.match(first, /src\/semantic\/semantic-command-descriptors\.ts#project\.advance/);
  assert.match(first, /`mcp:project\.advance#inputSchema`/);
  assert.match(first, /mcp\/project\.advance\.js#inputSchema/);
});