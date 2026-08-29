import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjectDefinitionFacts } from '../lib/project-definition-facts.js';
import { createProjectDefinitionFactsReader } from '../lib/project-definition-facts-reader.js';

const REVISION = '1234567890abcdef1234567890abcdef12345678';
const REPOSITORY = 'example/project';

test('exact-revision project facts can represent a repository with no definition yet', () => {
  const facts = normalizeProjectDefinitionFacts({
    schema:'project-definition-facts-v1',
    repository:REPOSITORY,
    revision:REVISION,
    definitions:[],
  });
  assert.deepEqual(facts.definitions, []);
  assert.equal(facts.revision, REVISION);
});

test('definition reader treats an exact 404 discovery absence as bootstrap-eligible, not read ambiguity', async () => {
  const calls = [];
  const client = { async call(name, input) {
    assert.equal(name, 'github');
    calls.push(input);
    if (input.path === `/repos/${REPOSITORY}/commits/${REVISION}`) {
      return { status:200, body:{ sha:REVISION } };
    }
    if (input.path === `/repos/${REPOSITORY}/contents/.overcenter/project-definitions.json`) {
      return { status:404, body:{ message:'Not Found' } };
    }
    throw new Error(`unexpected path ${input.path}`);
  } };

  const facts = await createProjectDefinitionFactsReader(client)({ repository:REPOSITORY, revision:REVISION });
  assert.deepEqual(facts.definitions, []);
  assert.equal(calls.at(-1).query.ref, REVISION);
});

test('definition reader still fails closed for non-404 discovery errors', async () => {
  const client = { async call(name, input) {
    if (input.path === `/repos/${REPOSITORY}/commits/${REVISION}`) return { status:200, body:{ sha:REVISION } };
    return { status:403, body:{ message:'Forbidden' } };
  } };
  await assert.rejects(
    () => createProjectDefinitionFactsReader(client)({ repository:REPOSITORY, revision:REVISION }),
    (error) => error?.code === 'PROJECT_DEFINITION_FACTS_READ_FAILED',
  );
});