import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeProjectDefineRequest,
  normalizeProjectAmendRequest,
} from '../lib/project-authoring-command-contract.js';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';

const revision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const projectRef = 'github:example/project';
const definition = {
  schema:'overcenter-project-definition-v1',
  project_ref:projectRef,
  transitions:[
    { id:'foundation', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
  ],
};

test('project.define exposes semantic intent without repository layout or transport bookkeeping', () => {
  const normalized = normalizeProjectDefineRequest({
    project_ref:projectRef,
    expected_revision:revision,
    definition,
  });
  assert.deepEqual(normalized, { project_ref:projectRef, expected_revision:revision, definition });
  for (const forbidden of ['branch','path','idempotency_key','commit_message','base_sha','lease_ref','run_id']) {
    assert.throws(() => normalizeProjectDefineRequest({ project_ref:projectRef, expected_revision:revision, definition, [forbidden]:'caller-owned' }), /unsupported field/);
  }
});

test('project.amend exposes semantic intent without orchestration bookkeeping', () => {
  const amendment = {
    upsert_transitions:[
      { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
    ],
  };
  const normalized = normalizeProjectAmendRequest({
    project_ref:projectRef,
    expected_revision:revision,
    amendment,
  });
  assert.deepEqual(normalized, { project_ref:projectRef, expected_revision:revision, amendment });
  for (const forbidden of ['branch','path','idempotency_key','commit_message','base_sha','lease_ref','run_id']) {
    assert.throws(() => normalizeProjectAmendRequest({ project_ref:projectRef, expected_revision:revision, amendment, [forbidden]:'caller-owned' }), /unsupported field/);
  }
});

test('project authoring command requests fail closed on inexact source authority', () => {
  assert.throws(() => normalizeProjectDefineRequest({ project_ref:projectRef, expected_revision:'dev', definition }), /40-character Git revision/);
  assert.throws(() => normalizeProjectAmendRequest({ project_ref:projectRef, expected_revision:'dev', amendment:{} }), /40-character Git revision/);
});

test('project authoring is exposed through canonical semantic descriptors', () => {
  const define = semanticCommandDescriptor('project.define');
  assert.equal(define.mcp_name, 'project.define');
  assert.deepEqual([...define.required_fields], ['project_ref','expected_revision','definition']);
  assert.deepEqual([...define.semantic_fields].sort(), ['definition','expected_revision','project_ref']);

  const amend = semanticCommandDescriptor('project.amend');
  assert.equal(amend.mcp_name, 'project.amend');
  assert.deepEqual([...amend.required_fields], ['project_ref','expected_revision','amendment']);
  assert.deepEqual([...amend.semantic_fields].sort(), ['amendment','expected_revision','project_ref']);

  for (const descriptor of [define, amend]) {
    for (const forbidden of ['branch','path','idempotency_key','commit_message','base_sha','lease_ref','run_id']) {
      assert.equal(Object.hasOwn(descriptor.input_schema.properties, forbidden), false, `${descriptor.command} leaked ${forbidden}`);
    }
  }
});

test('worker transport binds project authoring commands to semantic normalizers and an injected authoring service', async () => {
  const source = await readFile(new URL('../lib/worker-transport.js', import.meta.url), 'utf8');
  for (const command of ['project.define','project.amend']) {
    assert.match(source, new RegExp(`['\"]${command.replace('.', '\\.') }['\"]\\s*:`), `${command} is not admitted by worker transport`);
  }
  assert.match(source, /normalizeProjectDefineRequest/);
  assert.match(source, /normalizeProjectAmendRequest/);
  assert.match(source, /projectAuthoringFor\(runtime\)\.define\(request\)/);
  assert.match(source, /projectAuthoringFor\(runtime\)\.amend\(request\)/);
});