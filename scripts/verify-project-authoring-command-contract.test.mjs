import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeProjectDefineRequest,
  normalizeProjectAmendRequest,
  normalizeProjectAddConversationRequest,
} from '../lib/project-authoring-command-contract.js';
import { addConversationToProject } from '../lib/project-conversation-authoring.js';
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

test('project.add_conversation delegates only explicit judgment to canonical authoring and returns bounded provenance', async () => {
  const calls = [];
  const amendment = { upsert_transitions:[{ id:'conversation-node', priority:1, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] };
  const result = await addConversationToProject({
    project_ref:projectRef,
    expected_revision:revision,
    conversation:{
      text:'Conversation context that must not become graph authority.',
      citations:[{kind:'conversation_line',ref:'conversation:turn-9#L3-L4'}],
    },
    amendment,
  }, {
    async amend(request) {
      calls.push(request);
      return { ok:true, authority:{revision}, diff:{added:['conversation-node'],changed:[],removed:[]}, graph:{revision} };
    },
  });
  assert.deepEqual(calls, [{ project_ref:projectRef, expected_revision:revision, amendment }]);
  assert.equal(JSON.stringify(calls).includes('Conversation context'), false, 'conversation text leaked into authoritative amendment input');
  assert.deepEqual(result.diff, {added:['conversation-node'],changed:[],removed:[]});
  assert.deepEqual(result.conversation_provenance.citations, [{kind:'conversation_line',ref:'conversation:turn-9#L3-L4'}]);
  assert.equal(result.conversation_provenance.text_length, 'Conversation context that must not become graph authority.'.length);
  assert.equal(Object.hasOwn(result.conversation_provenance, 'text'), false, 'compact receipt retained full conversation text');
});

test('project authoring command requests fail closed on inexact source authority', () => {
  assert.throws(() => normalizeProjectDefineRequest({ project_ref:projectRef, expected_revision:'dev', definition }), /40-character Git revision/);
  assert.throws(() => normalizeProjectAmendRequest({ project_ref:projectRef, expected_revision:'dev', amendment:{} }), /40-character Git revision/);
  assert.throws(() => normalizeProjectAddConversationRequest({ project_ref:projectRef, expected_revision:'dev', conversation:{text:'x'}, amendment:{} }), /40-character Git revision/);
});

test('canonical project define and amend remain exposed through semantic descriptors', () => {
  const define = semanticCommandDescriptor('project.define');
  assert.equal(define.mcp_name, 'project.define');
  assert.deepEqual([...define.required_fields], ['project_ref','expected_revision','definition']);
  assert.deepEqual([...define.semantic_fields].sort(), ['definition','expected_revision','project_ref']);

  const amend = semanticCommandDescriptor('project.amend');
  assert.equal(amend.mcp_name, 'project.amend');
  assert.deepEqual([...amend.required_fields], ['project_ref','expected_revision','amendment']);
  assert.deepEqual([...amend.semantic_fields].sort(), ['amendment','expected_revision','project_ref']);

  for (const descriptor of [define, amend]) {
    assert.deepEqual(descriptor.exposure, { worker:true, mcp:true });
    assert.equal(MIGRATED_SEMANTIC_COMMANDS.includes(descriptor.command), true, `${descriptor.command} is not migrated`);
    for (const forbidden of ['branch','path','idempotency_key','commit_message','base_sha','lease_ref','run_id']) {
      assert.equal(Object.hasOwn(descriptor.input_schema.properties, forbidden), false, `${descriptor.command} leaked ${forbidden}`);
    }
  }
});

test('project.add_conversation is a stable MCP semantic facade over canonical project authoring', async () => {
  const source = await readFile(new URL('../mcp/project.add_conversation.js', import.meta.url), 'utf8');
  const contractSource = await readFile(new URL('../lib/project-authoring-mcp-contract.js', import.meta.url), 'utf8');
  assert.match(source, /name:'project\.add_conversation'/);
  assert.match(source, /reasoning layer/);
  assert.match(source, /deterministic graph kernel/);
  assert.match(source, /addConversationToProject\(args \|\| \{\}, projectAuthoringFor\(\{ db \}\)\)/);
  assert.match(contractSource, /PROJECT_ADD_CONVERSATION_INPUT_SCHEMA/);
  for (const forbidden of ['branch','path','idempotency_key','commit_message','base_sha','lease_ref','run_id']) {
    assert.equal(contractSource.includes(`${forbidden}:`), false, `conversation MCP contract leaked caller-owned ${forbidden}`);
  }
});
