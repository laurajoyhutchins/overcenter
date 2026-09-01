import assert from 'node:assert/strict';
import test from 'node:test';
import { renderCatalogMarkdown } from './render-markdown.mjs';

function catalog(unclassified = []) {
  return {
    schema:'contract-evidence-catalog-v1',
    repository:{ root_marker:'.' },
    generated_by:{ protocol:'contract-evidence-catalog-v1' },
    candidates:[],
    logical_contracts:[],
    unclassified_source_identities:unclassified,
    summary:{ discovered:0, classified:0, unclassified:unclassified.length, logical_contracts:0 },
  };
}

test('markdown projection has stable significance sections', () => {
  const markdown = renderCatalogMarkdown(catalog());
  const headings = [
    '# Data contracts',
    '## Public compatibility contracts',
    '## Authority/internal contracts',
    '## Durable internal contracts',
    '## Boundary-internal contracts',
    '## Implementation-only shapes',
  ];
  let cursor = -1;
  for (const heading of headings) {
    const next = markdown.indexOf(heading);
    assert.ok(next > cursor, `${heading} must appear in stable order`);
    cursor = next;
  }
  assert.doesNotMatch(markdown, /Unclassified historical debt/);
});

test('historical debt section disappears automatically at zero', () => {
  const markdown = renderCatalogMarkdown(catalog(['typescript:src/legacy.ts#Legacy']));
  assert.match(markdown, /## Unclassified historical debt/);
  assert.match(markdown, /typescript:src\/legacy\.ts#Legacy/);
});
