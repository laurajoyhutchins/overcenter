import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeProjectDefineRequest,
  normalizeProjectAmendRequest,
  normalizeProjectAddConversationRequest,
} from '../lib/project-authoring-command-contract.js';
import { MIGRATED_SEMANTIC_COMMANDS, semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';

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

test('project.add_conversation preserves conversation provenance while requiring explicit reasoning judgment', () => {
  const amendment = {
    upsert_transitions:[
      { id:'from-conversation', priority:4, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
    ],
  };
  const conversation = {
    text:'The durable decision is to add a bounded transition.\n',
    citations:[{ kind:'conversation_line', ref:'conversation:turn-7#L1' }],
  };
  const normalized = normalizeProjectAddConversationRequest({
    project_ref:projectRef,
    expected_revision:revision,
    conversation,
    amendment,
  });
  assert.deepEqual(normalized, { project_ref:projectRef, expected_revision:revision, conversation, amendment });
  assert.throws(() => normalizeProjectAddConversationRequest({ project_ref:projectRef, expected_revision:revision, conversation }), /amendment/);
  for (const forbidden of ['branch','path','idempotency_key','commit_message','base_sha','lease_ref','run_id']) {
    assert.throws(() => normalizeProjectAddConversationRequest({ project_ref:projectRef, expected_revision:revision, conversation, amendment, [forbidden]:'caller-owned' }), /unsupported field/);
  }
});

test('project authoring command requests fail closed on inexact source authority', () => {
  assert.throws(() => normalizeProjectDefineRequest({ project_ref:projectRef, expected_revision:'dev', definition }), /40-character Git revision/);
  assert.throws(() => normalizeProjectAmendRequest({ project_ref:projectRef, expected_revision:'dev', amendment:{} }), /40-character Git revision/);
  assert.throws(() => normalizeProjectAddConversationRequest({ project_ref:projectRef, expected_revision:'dev', conversation:{text:'x'}, amendment:{} }), /40-character Git revision/);
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

  const addConversation = semanticCommandDescriptor('project.add_conversation');
  assert.equal(addConversation.mcp_name, 'project.add_conversation');
  assert.deepEqual([...addConversation.required_fields], ['project_ref','expected_revision','conversation','amendment']);
  assert.deepEqual([...addConversation.semantic_fields].sort(), ['amendment','conversation','expected_revision','project_ref']);
  assert.match(addConversation.description, /reasoning layer/i);
  assert.match(addConversation.description, /validat/i);

  for (const descriptor of [define, amend, addConversation]) {
    assert.deepEqual(descriptor.exposure, { worker:true, mcp:true });
    assert.equal(MIGRATED_SEMANTIC_COMMANDS.includes(descriptor.command), true, `${descriptor.command} is not migrated`);
    for (const forbidden of ['branch','path','idempotency_key','commit_message','base_sha','lease_ref','run_id']) {
      assert.equal(Object.hasOwn(descriptor.input_schema.properties, forbidden), false, `${descriptor.command} leaked ${forbidden}`);
    }
  }
});

test('worker transport binds project authoring commands to semantic normalizers and an injected authoring service', async () => {
  const source = await readFile(new URL('../lib/worker-transport.js', import.meta.url), 'utf8');
  for (const command of ['project.define','project.amend','project.add_conversation']) {
    assert.match(source, new RegExp(`['\"]${command.replace('.', '\\.') }['\"]\\s*:`), `${command} is not admitted by worker transport`);
  }
  assert.match(source, /normalizeProjectDefineRequest/);
  assert.match(source, /normalizeProjectAmendRequest/);
  assert.match(source, /normalizeProjectAddConversationRequest/);
  assert.match(source, /projectAuthoringFor\(runtime\)\.define\(request\)/);
  assert.match(source, /projectAuthoringFor\(runtime\)\.amend\(request\)/);
  assert.match(source, /projectAuthoringFor\(runtime\)\.addConversation\(request\)/);
});
