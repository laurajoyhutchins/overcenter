import { executeCommand } from './command-response.js';
import { createProjectAuthoringGithubAdapter } from './project-authoring-github-runtime.js';

const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const REPOSITORY = 'laurajoyhutchins/overcenter';
const REVISION = 'a'.repeat(40);
const STAGED_REVISION = 'b'.repeat(40);
const AUTHORITY_REVISION = 'c'.repeat(40);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function transition(id) {
  return {
    id,
    priority: 1,
    requires: [],
    executor: { kind: 'agent', role: 'repository-implementation', skill: 'repository-editing' },
  };
}

function definition() {
  return {
    schema: 'overcenter-project-definition-v1',
    project_ref: PROJECT_REF,
    transitions: [transition('existing-transition')],
  };
}

function amendedDefinition() {
  return {
    schema: 'overcenter-project-definition-v1',
    project_ref: PROJECT_REF,
    transitions: [transition('existing-transition'), transition('new-transition')],
  };
}

function adapterFor({ applyChangeset, deriveProjectGraph, resolveAuthority, readDefinitionFacts }) {
  let authorityReads = 0;
  return createProjectAuthoringGithubAdapter({
    resolveAuthority: resolveAuthority || (async () => ({
      kind: 'github',
      project_ref: PROJECT_REF,
      repository: REPOSITORY,
      revision: ++authorityReads === 1 ? REVISION : AUTHORITY_REVISION,
      derivation: 'test-project-derivation',
    })),
    readDefinitionFacts: readDefinitionFacts || (async ({ revision }) => ({
      repository: REPOSITORY,
      revision,
      definitions: [{
        path: '.overcenter/definitions/overcenter.json',
        content: `${JSON.stringify(revision === REVISION ? definition() : amendedDefinition(), null, 2)}\n`,
      }],
    })),
    applyChangeset,
    deriveProjectGraph,
  });
}

async function amendWith(adapter) {
  return adapter.amend({
    project_ref: PROJECT_REF,
    expected_revision: REVISION,
    amendment: { upsert_transitions: [transition('new-transition')] },
  });
}

async function wrappedMutationFailure(mayHaveMutated) {
  const adapter = adapterFor({
    applyChangeset: async () => ({
      ok: false,
      error: mayHaveMutated ? 'GITHUB_UPSTREAM_ERROR' : 'HEAD_MISMATCH',
      message: 'simulated GitHub changeset failure',
      may_have_mutated: mayHaveMutated,
    }),
    deriveProjectGraph: async () => {
      throw new Error('deriveProjectGraph must not run after an unconfirmed mutation result');
    },
  });

  try {
    await amendWith(adapter);
  } catch (error) {
    return error;
  }
  throw new Error('project authoring unexpectedly accepted an unconfirmed mutation result');
}

async function thrownBoundaryFailure({ explicitlySafe = false } = {}) {
  let mutationBoundaryEntered = false;
  const failure = new Error('simulated response-path failure after GitHub mutation dispatch');
  if (explicitlySafe) failure.may_have_mutated = false;
  const adapter = adapterFor({
    applyChangeset: async () => {
      mutationBoundaryEntered = true;
      throw failure;
    },
    deriveProjectGraph: async () => {
      throw new Error('deriveProjectGraph must not run when changeset dispatch throws');
    },
  });

  try {
    await amendWith(adapter);
  } catch (error) {
    return { error, mutationBoundaryEntered };
  }
  throw new Error('project authoring unexpectedly accepted a thrown changeset failure');
}

async function postMutationReadbackFailure() {
  let mutationReceiptReturned = false;
  const adapter = adapterFor({
    applyChangeset: async () => {
      mutationReceiptReturned = true;
      return {
        ok: true,
        new_head: STAGED_REVISION,
        commit_sha: STAGED_REVISION,
        created_branch: true,
      };
    },
    deriveProjectGraph: async () => {
      throw new Error('simulated semantic readback failure after confirmed authoritative observation');
    },
  });

  try {
    await amendWith(adapter);
  } catch (error) {
    return { error, mutationReceiptReturned };
  }
  throw new Error('project authoring unexpectedly accepted a failed post-mutation readback');
}

async function testPotentialMutationEvidenceSurvivesSemanticWrapping() {
  const error = await wrappedMutationFailure(true);
  check(error?.code === 'PROJECT_AUTHORING_MUTATION_UNCONFIRMED', 'semantic wrapper code changed');
  check(error?.may_have_mutated === true, 'wrapper must expose may_have_mutated:true directly');
  check(error?.details?.may_have_mutated === true, 'wrapper details must expose may_have_mutated:true for worker-boundary serialization');
  check(error?.details?.result?.may_have_mutated === true, 'underlying GitHub mutation evidence must remain available');
}

async function testKnownPreMutationFailureRemainsSafe() {
  const error = await wrappedMutationFailure(false);
  check(error?.code === 'PROJECT_AUTHORING_MUTATION_UNCONFIRMED', 'semantic wrapper code changed for safe failure');
  check(error?.may_have_mutated === false, 'known pre-mutation failure must remain may_have_mutated:false');
  check(error?.details?.may_have_mutated === false, 'safe failure details must remain may_have_mutated:false');
}

async function testThrownFailureAfterMutationBoundaryDefaultsToPotentialMutation() {
  const { error, mutationBoundaryEntered } = await thrownBoundaryFailure();
  check(mutationBoundaryEntered, 'test did not enter the GitHub mutation boundary');
  check(error?.may_have_mutated === true, 'unclassified failure after GitHub mutation dispatch must default to may_have_mutated:true');
  check(error?.details?.may_have_mutated === true, 'mutation-boundary certainty must survive direct detail serialization');
}

async function testExplicitPreMutationThrowRemainsSafe() {
  const { error, mutationBoundaryEntered } = await thrownBoundaryFailure({ explicitlySafe:true });
  check(mutationBoundaryEntered, 'test did not enter the GitHub mutation boundary');
  check(error?.may_have_mutated === false, 'explicitly proven pre-mutation throw must remain may_have_mutated:false');
}

async function testConfirmedMutationThenReadbackFailureIsPotentiallyMutated() {
  const { error, mutationReceiptReturned } = await postMutationReadbackFailure();
  check(mutationReceiptReturned, 'test did not return a confirmed GitHub mutation receipt');
  check(error?.may_have_mutated === true, 'post-mutation semantic readback failure must be may_have_mutated:true');
  check(error?.details?.may_have_mutated === true, 'post-mutation readback certainty must survive direct detail serialization');
}

async function testConfirmedProjectAmendmentIsValidCommandSuccess() {
  let mutationCalls = 0;
  const adapter = adapterFor({
    applyChangeset: async () => {
      mutationCalls += 1;
      return {
        ok: true,
        new_head: STAGED_REVISION,
        commit_sha: STAGED_REVISION,
        created_branch: true,
      };
    },
    deriveProjectGraph: async (input) => ({ revision:input.authority.revision, nodes:[], horizons:[] }),
  });
  const response = await executeCommand(
    'project.amend',
    () => amendWith(adapter),
    { defaultError:'PROJECT_AMEND_ERROR', defaultMessage:'project.amend failed' },
  );
  check(mutationCalls === 1, 'project amendment did not cross the mutation boundary exactly once');
  check(response.status === 200, 'authoritatively observed project amendment was rejected as an invalid command result');
  check(response.body?.ok === true, 'authoritatively observed project amendment did not return a command success envelope');
  check(response.body?.authority?.revision === AUTHORITY_REVISION, 'project amendment did not return refreshed authority');
  check(response.body?.authority?.revision !== STAGED_REVISION, 'project amendment leaked staged work-branch revision as authority');
}

export async function runProjectAuthoringGithubRuntimeTests() {
  await testPotentialMutationEvidenceSurvivesSemanticWrapping();
  await testKnownPreMutationFailureRemainsSafe();
  await testThrownFailureAfterMutationBoundaryDefaultsToPotentialMutation();
  await testExplicitPreMutationThrowRemainsSafe();
  await testConfirmedMutationThenReadbackFailureIsPotentiallyMutated();
  await testConfirmedProjectAmendmentIsValidCommandSuccess();
  return { ok:true, tests:6 };
}
