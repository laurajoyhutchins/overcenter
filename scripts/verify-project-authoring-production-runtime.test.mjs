import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectAuthoringProductionRuntime, createProjectAuthoringProductionRuntimeFromHost } from '../lib/project-authoring-production-runtime.js';
import { createProjectAuthoringHostRuntime } from '../lib/project-authoring-host-runtime.js';
import { applyProjectTransitionObservations } from '../lib/project-transition-observations.js';
import { evaluateProjectGraph } from '../lib/project-graph.js';
import { createProjectTransitionLeaseService } from '../lib/project-transition-leases.js';

const initialRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const stagedRevision = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const authoritativeRevision = 'cccccccccccccccccccccccccccccccccccccccc';
const projectRef = 'github:example/project';
const baseDefinition = {
  schema:'overcenter-project-definition-v1',
  project_ref:projectRef,
  transitions:[{ id:'foundation', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }],
};
const amendedDefinition = {
  ...baseDefinition,
  transitions:[...baseDefinition.transitions, { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }],
};

function facts(revision, definition = baseDefinition) {
  return { schema:'project-definition-facts-v1', repository:'example/project', revision, definitions:[{ path:'.overcenter/definitions/project.json', content:JSON.stringify(definition) }] };
}

function authority(revision, ref = projectRef) {
  return { project_ref:ref, kind:'github', repository:'example/project', revision, derivation:'overcenter-project-graph-v1' };
}

function semanticTransition(id, { requires = [], role = 'implementation', priority = 1 } = {}) {
  return {
    id,
    priority,
    requires,
    executor:{ kind:'agent', role, skill:'test-driven-development' },
    phase_bindings:{},
  };
}

function liveExecution(transitionId, revision = 'dddddddddddddddddddddddddddddddddddddddd') {
  return Object.freeze({
    lease_id:`lease-${transitionId}`,
    transition_id:transitionId,
    authority_revision:revision,
    transition_revision_fingerprint:'e'.repeat(64),
    transition_definition_fingerprint:'f'.repeat(64),
    transition_dependency_fingerprint:'1'.repeat(64),
  });
}

function semanticConflictRuntime(initialDefinition, liveExecutionAuthorities) {
  let currentDefinition = initialDefinition;
  let mutated = false;
  let mutationCount = 0;
  const runtime = createProjectAuthoringProductionRuntime({
    resolveAuthority:async () => authority(mutated ? authoritativeRevision : initialRevision),
    readDefinitionFacts:async ({ revision }) => facts(revision, currentDefinition),
    readProjectObservations:async () => [],
    readProjectExecutionAuthorities:async () => liveExecutionAuthorities,
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    readSourceRevision:async () => initialRevision,
    applyChangeset:async (request) => {
      mutationCount += 1;
      const definitionChange = request.changes.find((change) => change.path.startsWith('.overcenter/definitions/'));
      currentDefinition = JSON.parse(definitionChange.content);
      mutated = true;
      return { ok:true, new_head:stagedRevision };
    },
    deriveProjectGraph:async ({ authority:observed }) => ({ schema:'overcenter-project-graph-v1', revision:observed.revision }),
  });
  return Object.freeze({ runtime, mutationCount:() => mutationCount });
}

test('project.amend confirms a semantic no-op without creating provider work-surface residue', async () => {
  let mutations = 0;
  let authorityReads = 0;
  const runtime = createProjectAuthoringProductionRuntime({
    resolveAuthority:async () => { authorityReads += 1; return authority(initialRevision); },
    readDefinitionFacts:async ({ revision }) => facts(revision, baseDefinition),
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    readSourceRevision:async () => initialRevision,
    applyChangeset:async () => { mutations += 1; throw new Error('semantic no-op must not create a changeset'); },
    deriveProjectGraph:async ({ authority:observed }) => ({ schema:'overcenter-project-graph-v1', revision:observed.revision }),
  });

  const result = await runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[baseDefinition.transitions[0]] },
  });

  assert.equal(result.ok, true);
  assert.equal(result.authority.revision, initialRevision);
  assert.deepEqual(result.diff, { added:[], changed:[], removed:[] });
  assert.equal(mutations, 0);
  assert.equal(authorityReads, 1);
});

test('staged underivable candidate is rejected before GitHub integration', async () => {
  let authorityReads = 0;
  let integrations = 0;
  const derivedRevisions = [];
  const runtime = createProjectAuthoringProductionRuntime({
    resolveAuthority:async () => ({ ...authority(++authorityReads <= 3 ? initialRevision : authoritativeRevision), branch:'dev' }),
    readDefinitionFacts:async ({ revision }) => revision === stagedRevision
      ? { ...facts(revision, amendedDefinition), definitions:[{ path:'.overcenter/definitions/project.json', content:`${JSON.stringify(amendedDefinition, null, 2)}\n` }] }
      : facts(revision, revision === initialRevision ? baseDefinition : amendedDefinition),
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    readSourceRevision:async () => initialRevision,
    applyChangeset:async () => ({ ok:true, new_head:stagedRevision }),
    deriveProjectGraph:async ({ authority:observed }) => {
      derivedRevisions.push(observed.revision);
      if (observed.revision === stagedRevision) {
        const error = new Error('candidate graph requires a missing transition');
        error.code = 'OVERCENTER_PROJECT_GRAPH_DERIVATION_INVALID';
        error.details = { node_id:'second', dependency:'missing' };
        throw error;
      }
      return { schema:'overcenter-project-graph-v1', revision:observed.revision };
    },
    integrateChangeset:async () => {
      integrations += 1;
      return { ok:true, outcome:'merged' };
    },
  });

  await assert.rejects(
    () => runtime.amend({
      project_ref:projectRef,
      expected_revision:initialRevision,
      amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
    }),
    (error) => error?.code === 'PROJECT_AUTHORING_CANDIDATE_DERIVATION_INVALID'
      && error?.may_have_mutated === true
      && error?.details?.staged_revision === stagedRevision
      && error?.details?.cause_code === 'OVERCENTER_PROJECT_GRAPH_DERIVATION_INVALID',
  );

  assert.equal(integrations, 0);
  assert.equal(derivedRevisions.includes(stagedRevision), true);
});

test('runtime composition grants exact source mutation authority and confirms success through refreshed repository authority', async () => {
  const calls = [];
  let authorityReads = 0;
  const runtime = createProjectAuthoringProductionRuntime({
    resolveAuthority:async () => authority(++authorityReads === 1 ? initialRevision : authoritativeRevision),
    readDefinitionFacts:async ({ revision }) => revision === authoritativeRevision ? facts(revision, amendedDefinition) : facts(revision),
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    readSourceRevision:async () => initialRevision,
    applyChangeset:async (request, options) => {
      const mutationAuthority = await options.executionAuthority.require({ repository:request.repo });
      calls.push({ request, authority:mutationAuthority });
      return { ok:true, new_head:stagedRevision };
    },
    deriveProjectGraph:async ({ authority:observed }) => ({ schema:'overcenter-project-graph-v1', revision:observed.revision }),
  });

  const result = await runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  });

  assert.equal(authorityReads, 2);
  assert.equal(result.authority.revision, authoritativeRevision);
  assert.notEqual(result.authority.revision, stagedRevision);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authority.subject, 'project_definition');
  assert.equal(calls[0].authority.operation, 'amend');
  assert.equal(calls[0].authority.authority_revision, initialRevision);
  assert.equal('lease_ref' in calls[0].request, false);
  assert.equal('run_id' in calls[0].request, false);
});

test('runtime host binding consumes bounded capabilities and re-resolves authority after mutation', async () => {
  const calls = [];
  let authorityReads = 0;
  const runtime = createProjectAuthoringProductionRuntimeFromHost({
    projectAuthority:{ resolve:async () => authority(++authorityReads < 3 ? initialRevision : authoritativeRevision) },
    definitionFacts:{ read:async ({ revision }) => revision === authoritativeRevision ? facts(revision, amendedDefinition) : facts(revision) },
    repositoryDisposition:{ read:async (repository) => ({ repository, disposition:'ACTIVE' }) },
    githubChangeset:{ apply:async (request, options) => {
      const mutationAuthority = await options.executionAuthority.require({ repository:request.repo });
      calls.push({ request, authority:mutationAuthority });
      return { ok:true, new_head:stagedRevision };
    } },
    projectGraph:{ derive:async ({ authority:observed }) => ({ schema:'overcenter-project-graph-v1', revision:observed.revision }) },
  });

  const result = await runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  });

  assert.equal(authorityReads, 3);
  assert.equal(result.authority.revision, authoritativeRevision);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authority.subject, 'project_definition');
});

test('runtime host binding reuses projectAuthority for mutation fencing and post-mutation authoritative readback', async () => {
  const authorityReads = [];
  const runtime = createProjectAuthoringProductionRuntimeFromHost({
    projectAuthority:{ resolve:async ({ project_ref }) => {
      authorityReads.push(project_ref);
      return authority(authorityReads.length < 3 ? initialRevision : authoritativeRevision, project_ref);
    } },
    definitionFacts:{ read:async ({ revision }) => revision === authoritativeRevision ? facts(revision, amendedDefinition) : facts(revision) },
    repositoryDisposition:{ read:async (repository) => ({ repository, disposition:'ACTIVE' }) },
    githubChangeset:{ apply:async (request, options) => {
      await options.executionAuthority.require({ repository:request.repo });
      return { ok:true, new_head:stagedRevision };
    } },
    projectGraph:{ derive:async ({ authority:observed }) => ({ schema:'overcenter-project-graph-v1', revision:observed.revision }) },
  });

  const result = await runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  });

  assert.equal(result.authority.revision, authoritativeRevision);
  assert.deepEqual(authorityReads, [projectRef, projectRef, projectRef]);
});

test('host adapter binds source authority, facts, disposition, changeset, graph, and refreshed authority without importing the runtime host', async () => {
  const calls = [];
  let authorityReads = 0;
  const graphRuntime = {
    resolveProjectAuthority:async ({ project_ref }) => authority(++authorityReads < 3 ? initialRevision : authoritativeRevision, project_ref),
    readProjectFacts:async ({ revision }) => ({ schema:'project-authority-facts-v1', repository:'example/project', revision, facts:{ definition_facts:revision === authoritativeRevision ? facts(revision, amendedDefinition) : facts(revision) } }),
  };
  const runtime = createProjectAuthoringHostRuntime({
    graphRuntime,
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    applyGithubChangeset:async (request, options) => {
      const mutationAuthority = await options.executionAuthority.require({ repository:request.repo });
      calls.push({ request, authority:mutationAuthority });
      return { ok:true, new_head:stagedRevision };
    },
    deriveProjectGraph:async ({ authority:observed }) => ({ schema:'overcenter-project-graph-v1', revision:observed.revision }),
  });

  const result = await runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  });

  assert.equal(authorityReads, 3);
  assert.equal(result.authority.revision, authoritativeRevision);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authority.subject, 'project_definition');
  assert.equal(calls[0].authority.authority_revision, initialRevision);
});

test('host adapter rejects stale authoritative source before any GitHub mutation', async () => {
  let mutations = 0;
  const graphRuntime = {
    resolveProjectAuthority:async ({ project_ref }) => authority(authoritativeRevision, project_ref),
    readProjectFacts:async () => { throw new Error('stale authority must fail before definition readback'); },
  };
  const runtime = createProjectAuthoringHostRuntime({
    graphRuntime,
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    applyGithubChangeset:async () => { mutations += 1; return { ok:true, new_head:stagedRevision }; },
    deriveProjectGraph:async () => { throw new Error('stale authority must fail before graph derivation'); },
  });

  await assert.rejects(
    () => runtime.amend({
      project_ref:projectRef,
      expected_revision:initialRevision,
      amendment:{ upsert_transitions:[] },
    }),
    (error) => error?.code === 'PROJECT_AUTHORING_AUTHORITY_STALE',
  );
  assert.equal(mutations, 0);
});

test('authoritative advancement rejects a stale semantic replay before a second physical source mutation', async () => {
  const requests = [];
  const committed = new Map();
  let physicalMutations = 0;
  let authorityReads = 0;
  const graphRuntime = {
    resolveProjectAuthority:async ({ project_ref }) => authority(++authorityReads <= 2 ? initialRevision : authoritativeRevision, project_ref),
    readProjectFacts:async ({ revision }) => ({
      schema:'project-authority-facts-v1',
      repository:'example/project',
      revision,
      facts:{ definition_facts:revision === authoritativeRevision ? facts(revision, amendedDefinition) : facts(revision) },
    }),
  };
  const runtime = createProjectAuthoringHostRuntime({
    graphRuntime,
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    applyGithubChangeset:async (request, options) => {
      const mutationAuthority = await options.executionAuthority.require({ repository:request.repo });
      assert.equal(mutationAuthority.authority_revision, initialRevision);
      requests.push(request);
      const replay = committed.get(request.idempotency_key);
      if (replay) return replay;
      physicalMutations += 1;
      const result = { ok:true, new_head:stagedRevision };
      committed.set(request.idempotency_key, result);
      return result;
    },
    deriveProjectGraph:async ({ authority:observed }) => ({ schema:'overcenter-project-graph-v1', revision:observed.revision }),
  });
  const input = {
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  };

  const first = await runtime.amend(input);
  await assert.rejects(
    () => runtime.amend(input),
    (error) => error?.code === 'PROJECT_AUTHORING_AUTHORITY_STALE',
  );

  assert.equal(physicalMutations, 1);
  assert.equal(requests.length, 1);
  assert.equal(first.authority.revision, authoritativeRevision);
  assert.equal(first.graph.revision, authoritativeRevision);
});

test('project.amend allows an unrelated obligation change while a disjoint transition is executing', async () => {
  const definition = {
    schema:'overcenter-project-definition-v1',
    project_ref:projectRef,
    transitions:[semanticTransition('A'), semanticTransition('C')],
  };
  const harness = semanticConflictRuntime(definition, [liveExecution('A')]);
  const result = await harness.runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[semanticTransition('C', { role:'verification' })] },
  });
  assert.equal(result.ok, true);
  assert.equal(harness.mutationCount(), 1);
});

test('project.amend rejects a semantic change to a live obligation before mutation', async () => {
  const definition = {
    schema:'overcenter-project-definition-v1',
    project_ref:projectRef,
    transitions:[semanticTransition('A')],
  };
  const harness = semanticConflictRuntime(definition, [liveExecution('A')]);
  await assert.rejects(
    () => harness.runtime.amend({
      project_ref:projectRef,
      expected_revision:initialRevision,
      amendment:{ upsert_transitions:[semanticTransition('A', { role:'verification' })] },
    }),
    (error) => error?.code === 'PROJECT_AUTHORING_LIVE_SEMANTIC_CONFLICT'
      && error?.may_have_mutated === false
      && error?.details?.conflicting_live_transition_ids?.includes('A'),
  );
  assert.equal(harness.mutationCount(), 0);
});

test('project.amend rejects a dependency change whose change region contains a live downstream obligation', async () => {
  const definition = {
    schema:'overcenter-project-definition-v1',
    project_ref:projectRef,
    transitions:[
      semanticTransition('A'),
      semanticTransition('D'),
      semanticTransition('B', { requires:['A'] }),
      semanticTransition('C', { requires:['B'] }),
    ],
  };
  const harness = semanticConflictRuntime(definition, [liveExecution('C')]);
  await assert.rejects(
    () => harness.runtime.amend({
      project_ref:projectRef,
      expected_revision:initialRevision,
      amendment:{ upsert_transitions:[semanticTransition('B', { requires:['A', 'D'] })] },
    }),
    (error) => error?.code === 'PROJECT_AUTHORING_LIVE_SEMANTIC_CONFLICT'
      && error?.may_have_mutated === false
      && error?.details?.dependency_changed_transition_ids?.includes('B')
      && error?.details?.affected_transition_ids?.includes('C')
      && error?.details?.conflicting_live_transition_ids?.includes('C'),
  );
  assert.equal(harness.mutationCount(), 0);
});

test('project.amend does not treat a live lease from another Git revision as a conflict when obligation semantics are unchanged', async () => {
  const definition = {
    schema:'overcenter-project-definition-v1',
    project_ref:projectRef,
    transitions:[semanticTransition('A', { priority:1 })],
  };
  const harness = semanticConflictRuntime(definition, [
    liveExecution('A', '2222222222222222222222222222222222222222'),
  ]);
  const result = await harness.runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[semanticTransition('A', { priority:999 })] },
  });
  assert.equal(result.ok, true);
  assert.equal(harness.mutationCount(), 1);
});

const migrationRevision1 = '1111111111111111111111111111111111111111';
const migrationRevision2 = '2222222222222222222222222222222222222222';
const migrationStages = ['ENABLE', 'ACQUIRE', 'EXECUTE', 'COMMIT', 'CONFIRM'];

function migrationLifecycle(complete = false) {
  return {
    current_stage:complete ? 'CONFIRM' : 'ENABLE',
    condition:'NOMINAL',
    responsibilities:Object.fromEntries(migrationStages.map((stage) => [
      stage,
      { applicable:true, satisfied:complete },
    ])),
  };
}

function concurrentMigrationHarness(initialDefinition) {
  let currentDefinition = initialDefinition;
  let currentRevision = migrationRevision1;
  let mutationCount = 0;
  let lastSettlement = null;
  const leases = new Map();
  const slots = new Map();
  const run = { run_id:'migration-run', status:'active', deadline_at:'2026-09-05T18:00:00Z' };

  const graph = () => ({
    schema:'project-graph-authority-v1',
    project_ref:projectRef,
    authority:{
      definition:{ kind:'github', repository:'example/project', revision:currentRevision, derivation:'overcenter-project-graph-v1' },
      observations:[],
    },
    nodes:currentDefinition.transitions.map((transition) => ({
      ...transition,
      phase_bindings:transition.phase_bindings ?? {},
      lifecycle:migrationLifecycle(transition.id === 'A'),
    })),
    horizons:[],
  });

  const store = {
    async getRun(id) { return id === run.run_id ? run : null; },
    async getLease(id) { return leases.get(id) || null; },
    async getLeaseByAcquireIdempotency(key) {
      return [...leases.values()].find((lease) => lease.acquire_idempotency_key === key) || null;
    },
    async getSlot(key) { return slots.get(key) || null; },
    async insertLease(row) { leases.set(row.lease_id, { ...row }); return leases.get(row.lease_id); },
    async insertSlot(row) {
      if (slots.has(row.slot_key)) { const error = new Error('occupied'); error.code = 'UNIQUE_VIOLATION'; throw error; }
      slots.set(row.slot_key, { ...row });
      return slots.get(row.slot_key);
    },
    async updateLease(id, patch) {
      const row = { ...leases.get(id), ...patch };
      leases.set(id, row);
      return row;
    },
    async getActiveLeasesForTransition(ref, transitionId, observedAt) {
      return [...leases.values()].filter((lease) => lease.project_ref === ref
        && lease.transition_id === transitionId
        && lease.status === 'active'
        && Date.parse(lease.expires_at) > Date.parse(observedAt));
    },
    async settleLeaseAtomically(input) {
      lastSettlement = input;
      const row = {
        ...leases.get(input.lease_id),
        status:'settled',
        disposition:input.disposition,
        settle_idempotency_key:input.settle_idempotency_key,
        settled_at:input.settled_at,
        graph_revision_change:input.graph_revision_change || null,
      };
      leases.set(input.lease_id, row);
      if (slots.get(input.slot_key)?.lease_id === input.lease_id) slots.delete(input.slot_key);
      return row;
    },
    async deleteSlot(key, id) { if (slots.get(key)?.lease_id === id) slots.delete(key); },
  };

  const projectTransitions = createProjectTransitionLeaseService({
    store,
    readProjectGraph:async () => graph(),
    now:() => '2026-09-05T15:00:00Z',
    uuid:() => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });

  const projectAuthoring = createProjectAuthoringProductionRuntime({
    resolveAuthority:async () => authority(currentRevision),
    readDefinitionFacts:async ({ revision }) => facts(revision, currentDefinition),
    readProjectObservations:async () => [],
    readProjectExecutionAuthorities:async () => [...leases.values()].filter((lease) => lease.status === 'active'),
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    readSourceRevision:async () => currentRevision,
    applyChangeset:async (request) => {
      mutationCount += 1;
      const definitionChange = request.changes.find((change) => change.path.startsWith('.overcenter/definitions/'));
      currentDefinition = JSON.parse(definitionChange.content);
      currentRevision = migrationRevision2;
      return { ok:true, new_head:migrationRevision2 };
    },
    deriveProjectGraph:async ({ authority:observed }) => ({ schema:'overcenter-project-graph-v1', revision:observed.revision }),
  });

  return {
    projectTransitions,
    projectAuthoring,
    graph,
    mutationCount:() => mutationCount,
    lastSettlement:() => lastSettlement,
    forceDefinition(definition, revision = migrationRevision2) { currentDefinition = definition; currentRevision = revision; },
  };
}

test('in-flight obligation settles across an unrelated project.amend and current frontier is derived under the new graph', async () => {
  const definition = {
    schema:'overcenter-project-definition-v1',
    project_ref:projectRef,
    transitions:[
      semanticTransition('A'),
      semanticTransition('B', { requires:['A'], priority:10 }),
      semanticTransition('C', { priority:5 }),
    ],
  };
  const harness = concurrentMigrationHarness(definition);
  const lease = await harness.projectTransitions.acquire({
    run_id:'migration-run',
    project_ref:projectRef,
    transition_id:'B',
    lease_seconds:600,
    idempotency_key:'migration-acquire-b',
  });
  assert.equal(lease.authority.revision, migrationRevision1);

  const amendment = await harness.projectAuthoring.amend({
    project_ref:projectRef,
    expected_revision:migrationRevision1,
    amendment:{ upsert_transitions:[semanticTransition('C', { role:'verification', priority:5 })] },
  });
  assert.equal(amendment.authority.revision, migrationRevision2);
  assert.equal(harness.mutationCount(), 1);

  const retained = await harness.projectTransitions.require({
    lease_ref:lease.lease_ref,
    run_id:'migration-run',
    repository:'example/project',
    transition_id:'B',
  });
  assert.equal(retained.authority.revision, migrationRevision2);
  assert.equal(retained.graph_revision_change.previous_authority.revision, migrationRevision1);
  assert.equal(retained.graph_revision_change.current_authority.revision, migrationRevision2);
  assert.equal(retained.transition_revision_fingerprint, lease.transition_revision_fingerprint);
  assert.equal(retained.transition_dependency_fingerprint, lease.transition_dependency_fingerprint);

  const settlement = await harness.projectTransitions.settle({
    lease_ref:lease.lease_ref,
    run_id:'migration-run',
    disposition:'completed',
    evidence:[{ kind:'migration-proof', ref:'B@G1' }],
    reason:'B completed under its G1 execution authority after disjoint G2 amendment',
    idempotency_key:'migration-settle-b',
  });
  assert.equal(settlement.disposition, 'completed');
  assert.equal(settlement.graph_revision_change.previous_authority.revision, migrationRevision1);
  assert.equal(settlement.graph_revision_change.current_authority.revision, migrationRevision2);

  const durable = harness.lastSettlement();
  assert.equal(durable.authority_revision, migrationRevision1);
  assert.deepEqual(durable.evidence, [{ kind:'migration-proof', ref:'B@G1' }]);
  assert.equal(durable.graph_revision_change.current_authority.revision, migrationRevision2);

  const current = harness.graph();
  const observedNodes = await applyProjectTransitionObservations({
    project_ref:projectRef,
    authority:current.authority.definition,
    nodes:current.nodes,
    observations:[{
      schema:'project-transition-observation-v1',
      kind:'project_transition_confirmation',
      project_ref:projectRef,
      transition_id:'B',
      transition_definition_fingerprint:durable.transition_definition_fingerprint,
      disposition:'completed',
      authority:{
        kind:'github',
        repository:'example/project',
        revision:durable.authority_revision,
        derivation:durable.authority_derivation,
      },
      provenance:{
        kind:'project_transition_settlement',
        lease_ref:lease.lease_ref,
        run_id:'migration-run',
        settled_at:durable.settled_at,
      },
    }],
  });
  const evaluated = evaluateProjectGraph({ ...current, nodes:observedNodes });
  assert.equal(evaluated.nodes.find((node) => node.id === 'B').state, 'DONE');
  assert.deepEqual(evaluated.frontier.map((node) => node.id), ['C']);
});

test('semantic prerequisite change touching live work cannot silently settle old authority into the new graph', async () => {
  const definition = {
    schema:'overcenter-project-definition-v1',
    project_ref:projectRef,
    transitions:[
      semanticTransition('A'),
      semanticTransition('X'),
      semanticTransition('B', { requires:['A'], priority:10 }),
    ],
  };
  const harness = concurrentMigrationHarness(definition);
  const lease = await harness.projectTransitions.acquire({
    run_id:'migration-run',
    project_ref:projectRef,
    transition_id:'B',
    lease_seconds:600,
    idempotency_key:'migration-conflict-acquire-b',
  });
  const changedB = semanticTransition('B', { requires:['A', 'X'], priority:10 });

  await assert.rejects(
    () => harness.projectAuthoring.amend({
      project_ref:projectRef,
      expected_revision:migrationRevision1,
      amendment:{ upsert_transitions:[changedB] },
    }),
    (error) => error?.code === 'PROJECT_AUTHORING_LIVE_SEMANTIC_CONFLICT'
      && error?.may_have_mutated === false
      && error?.details?.conflicting_live_transition_ids?.includes('B'),
  );
  assert.equal(harness.mutationCount(), 0);

  harness.forceDefinition({ ...definition, transitions:definition.transitions.map((transition) => transition.id === 'B' ? changedB : transition) });
  await assert.rejects(
    () => harness.projectTransitions.settle({
      lease_ref:lease.lease_ref,
      run_id:'migration-run',
      disposition:'completed',
      idempotency_key:'migration-conflict-settle-b',
    }),
    (error) => error?.code === 'PROJECT_TRANSITION_AUTHORITY_STALE'
      && error?.details?.reason === 'dependency-changed',
  );
});
