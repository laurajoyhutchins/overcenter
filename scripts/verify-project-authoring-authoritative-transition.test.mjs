import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectAuthoringProductionRuntime } from '../lib/project-authoring-production-runtime.js';
import { createGitHubProjectGraphRuntime } from '../lib/project-graph-github-runtime.js';

const initialRevision = 'a'.repeat(40);
const stagedRevision = 'b'.repeat(40);
const authoritativeRevision = 'c'.repeat(40);
const projectRef = 'github:example/project';
const baseDefinition = {
  schema:'overcenter-project-definition-v1',
  project_ref:projectRef,
  transitions:[
    { id:'foundation', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
  ],
};
const amendedDefinition = {
  ...baseDefinition,
  transitions:[
    ...baseDefinition.transitions,
    { id:'verify', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'verification', skill:'verification-before-completion' } },
  ],
};

function authority(revision) {
  return {
    project_ref:projectRef,
    kind:'github',
    repository:'example/project',
    branch:'dev',
    revision,
    derivation:'overcenter-project-graph-v1',
  };
}

function facts(revision, definition) {
  return {
    schema:'project-definition-facts-v1',
    repository:'example/project',
    revision,
    definitions:[{
      path:'.overcenter/definitions/project.json',
      content:`${JSON.stringify(definition, null, 2)}\n`,
    }],
  };
}

test('project.amend confirms the staged candidate and integrates it before authoritative readback', async () => {
  let integrated = false;
  let integrationCalls = 0;
  const readRevisions = [];
  const runtime = createProjectAuthoringProductionRuntime({
    resolveAuthority:async () => authority(integrated ? authoritativeRevision : initialRevision),
    readDefinitionFacts:async ({ revision }) => {
      readRevisions.push(revision);
      if (revision === stagedRevision || revision === authoritativeRevision) return facts(revision, amendedDefinition);
      return facts(revision, baseDefinition);
    },
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    readSourceRevision:async () => initialRevision,
    applyChangeset:async () => ({ ok:true, new_head:stagedRevision }),
    integrateChangeset:async (request) => {
      integrationCalls += 1;
      assert.equal(request.operation, 'amend');
      assert.equal(request.project_ref, projectRef);
      assert.equal(request.repository, 'example/project');
      assert.equal(request.base, 'dev');
      assert.equal(request.expected_base, initialRevision);
      assert.equal(request.expected_head, stagedRevision);
      assert.match(request.head, /^chore\/project-authoring-amend-[0-9a-f]{24}$/);
      assert.match(request.idempotency_key, /^project-amend-v1:[0-9a-f]{64}$/);
      integrated = true;
      return { ok:true, outcome:'merged', pull_request:123, merge_commit_sha:authoritativeRevision };
    },
    deriveProjectGraph:async ({ authority:observed }) => ({
      schema:'overcenter-project-graph-v1',
      revision:observed.revision,
      nodes:[],
      horizons:[],
    }),
  });

  const result = await runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{
      upsert_transitions:[
        { id:'verify', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'verification', skill:'verification-before-completion' } },
      ],
    },
  });

  assert.equal(integrationCalls, 1);
  assert.equal(result.authority.revision, authoritativeRevision);
  assert.equal(result.graph.revision, authoritativeRevision);
  assert.deepEqual(readRevisions, [initialRevision, stagedRevision, authoritativeRevision, authoritativeRevision]);
});

test('project.amend reports integration waiting instead of a canonical readback mismatch', async () => {
  const runtime = createProjectAuthoringProductionRuntime({
    resolveAuthority:async () => authority(initialRevision),
    readDefinitionFacts:async ({ revision }) => revision === stagedRevision ? facts(revision, amendedDefinition) : facts(revision, baseDefinition),
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    readSourceRevision:async () => initialRevision,
    applyChangeset:async () => ({ ok:true, new_head:stagedRevision }),
    integrateChangeset:async () => ({ ok:true, outcome:'waiting', pull_request:123, waiting_for:['required_status_checks'] }),
    deriveProjectGraph:async () => { throw new Error('canonical graph must not be derived before integration'); },
  });

  await assert.rejects(
    () => runtime.amend({
      project_ref:projectRef,
      expected_revision:initialRevision,
      amendment:{
        upsert_transitions:[
          { id:'verify', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'verification', skill:'verification-before-completion' } },
        ],
      },
    }),
    (error) => error?.code === 'PROJECT_AUTHORING_INTEGRATION_PENDING'
      && error?.may_have_mutated === true
      && error?.details?.integration?.outcome === 'waiting'
      && error?.details?.staged_revision === stagedRevision,
  );
});

test('managed GitHub project authority follows the development branch instead of the repository default branch', async () => {
  const devRevision = 'd'.repeat(40);
  const declaration = JSON.stringify({
    schema:'project-graph-derivation-v1',
    derivation:'overcenter-project-graph-v1',
  });
  const encodedDeclaration = Buffer.from(declaration, 'utf8').toString('base64');
  const observedPaths = [];
  const runtime = createGitHubProjectGraphRuntime({
    db:{ query:async () => ({ rows:[] }) },
    resolveRepositoryBranchRoles:async () => ({
      repository:'example/project',
      development_branch:'dev',
      production_branch:'main',
      production_source_ref:'github:example/project#dev',
    }),
    readProjectDefinitionFactsWithGitHubApp:async () => ({ definitions:[] }),
    withGitHubAppApiClient:async (_repository, callback) => callback({
      call:async (_service, request) => {
        observedPaths.push({ path:request.path, query:request.query || null });
        if (request.path === '/repos/example/project') return { status:200, body:{ default_branch:'main' } };
        if (request.path === '/repos/example/project/commits/dev') return { status:200, body:{ sha:devRevision } };
        if (request.path === '/repos/example/project/contents/.overcenter/project-graph.json') {
          return {
            status:200,
            body:{ type:'file', encoding:'base64', content:encodedDeclaration, size:Buffer.byteLength(declaration) },
          };
        }
        return { status:404, body:{ message:'not found' } };
      },
    }),
  });

  const observed = await runtime.resolveProjectAuthority({ project_ref:projectRef });
  assert.equal(observed.branch, 'dev');
  assert.equal(observed.revision, devRevision);
  assert.equal(observed.derivation, 'overcenter-project-graph-v1');
  assert.equal(observedPaths.some((entry) => entry.path === '/repos/example/project/commits/main'), false);
  assert.equal(observedPaths.some((entry) => entry.path === '/repos/example/project/commits/dev'), true);
  assert.deepEqual(
    observedPaths.find((entry) => entry.path.endsWith('/.overcenter/project-graph.json'))?.query,
    { ref:devRevision },
  );
});
