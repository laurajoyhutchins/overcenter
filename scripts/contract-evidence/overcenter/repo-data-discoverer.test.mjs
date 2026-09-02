import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createRepoDataDiscoverer } from './repo-data-discoverer.mjs';

test('discovers repository-owned JSON by declared schema rather than source whitespace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contract-repo-data-'));
  try {
    await mkdir(join(root, '.overcenter/definitions'), { recursive:true });
    await writeFile(join(root, '.overcenter/project-definitions.json'), '{\n  "schema": "project-definition-discovery-v1", "definitions": [".overcenter/definitions/target.json"]\n}\n', 'utf8');
    await writeFile(join(root, '.overcenter/definitions/target.json'), JSON.stringify({
      schema:'overcenter-project-definition-v1',
      project_ref:'github:example/repo',
      transitions:[],
    }, null, 4), 'utf8');
    const result = await createRepoDataDiscoverer({
      roots:['.overcenter/project-definitions.json', '.overcenter/definitions'],
    }).discover({ repoRoot:root });
    assert.deepEqual(result.candidates.map((item) => item.source_identity), [
      'repo-data:.overcenter/definitions/target.json#overcenter-project-definition-v1',
      'repo-data:.overcenter/project-definitions.json#project-definition-discovery-v1',
    ]);
    assert.equal(result.candidates[0].structure.schema, 'overcenter-project-definition-v1');
  } finally {
    await rm(root, { recursive:true, force:true });
  }
});

test('fingerprints repository-owned JSON contracts by structure rather than mutable instance values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contract-repo-data-values-'));
  try {
    await mkdir(join(root, '.overcenter/definitions'), { recursive:true });
    const path = join(root, '.overcenter/definitions/target.json');
    const writeDefinition = async ({ projectRef, id, priority }) => writeFile(path, JSON.stringify({
      schema:'overcenter-project-definition-v1',
      project_ref:projectRef,
      transitions:[{
        id,
        priority,
        requires:[],
        executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' },
      }],
    }, null, 2), 'utf8');

    await writeDefinition({ projectRef:'github:example/one', id:'first-transition', priority:10 });
    const before = await createRepoDataDiscoverer({ roots:['.overcenter/definitions'] }).discover({ repoRoot:root });
    await writeDefinition({ projectRef:'github:example/two', id:'second-transition', priority:999 });
    const after = await createRepoDataDiscoverer({ roots:['.overcenter/definitions'] }).discover({ repoRoot:root });

    assert.equal(after.candidates[0].source_identity, before.candidates[0].source_identity);
    assert.equal(after.candidates[0].structural_fingerprint, before.candidates[0].structural_fingerprint);
    assert.deepEqual(after.candidates[0].structure, before.candidates[0].structure);
  } finally {
    await rm(root, { recursive:true, force:true });
  }
});