import { createProjectAuthoringGithubAdapter } from './project-authoring-github-runtime.js';

const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const REPOSITORY = 'laurajoyhutchins/overcenter';
const REVISION = 'a'.repeat(40);

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

async function wrappedMutationFailure(mayHaveMutated) {
  const adapter = createProjectAuthoringGithubAdapter({
    resolveAuthority: async () => ({
      kind: 'github',
      project_ref: PROJECT_REF,
      repository: REPOSITORY,
      revision: REVISION,
      derivation: 'test-project-derivation',
    }),
    readDefinitionFacts: async () => ({
      definitions: [{
        path: '.overcenter/definitions/overcenter.json',
        content: `${JSON.stringify(definition(), null, 2)}\n`,
      }],
    }),
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
    await adapter.amend({
      project_ref: PROJECT_REF,
      expected_revision: REVISION,
      amendment: { upsert_transitions: [transition('new-transition')] },
    });
  } catch (error) {
    return error;
  }
  throw new Error('project authoring unexpectedly accepted an unconfirmed mutation result');
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

export async function runProjectAuthoringGithubRuntimeTests() {
  await testPotentialMutationEvidenceSurvivesSemanticWrapping();
  await testKnownPreMutationFailureRemainsSafe();
  return { ok:true, tests:2 };
}