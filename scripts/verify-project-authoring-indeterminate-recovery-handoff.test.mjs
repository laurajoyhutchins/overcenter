import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectAuthoringProductionRuntime } from '../lib/project-authoring-production-runtime.js';
import { classifyOrchestrationFailure } from '../lib/orchestration-failures.js';
import { sanitizeWorkerBoundaryError } from '../lib/worker-boundary-errors.js';

const initialRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const stagedRevision = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
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

function authority() {
  return {
    project_ref:projectRef,
    kind:'github',
    repository:'example/project',
    revision:initialRevision,
    branch:'dev',
    derivation:'overcenter-project-graph-v1',
  };
}

test('indeterminate project authoring integration acquires durable recovery ownership before surfacing failure', async () => {
  const recoveries = [];
  const runtime = createProjectAuthoringProductionRuntime({
    resolveAuthority:async () => authority(),
    readDefinitionFacts:async ({ revision }) => facts(revision, revision === stagedRevision ? amendedDefinition : baseDefinition),
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    readSourceRevision:async () => initialRevision,
    applyChangeset:async () => ({ ok:true, new_head:stagedRevision }),
    deriveProjectGraph:async ({ authority:observed }) => ({ schema:'overcenter-project-graph-v1', revision:observed.revision }),
    integrateChangeset:async () => {
      const error = new Error('socket hang up');
      error.code = 'GITHUB_INTEGRATION_INDETERMINATE';
      error.may_have_mutated = true;
      error.details = { may_have_mutated:true };
      throw error;
    },
    beginProjectAuthoringRecovery:async (input) => {
      recoveries.push(input);
      return {
        ok:true,
        outcome:'WAITING_EXTERNAL_VERIFICATION',
        recovery_ref:`project-authoring:${input.project_ref}:${input.idempotency_key}`,
        staged_revision:input.staged_revision,
        waiting_on:input.waiting_on,
      };
    },
  });

  await assert.rejects(
    () => runtime.amend({
      project_ref:projectRef,
      expected_revision:initialRevision,
      amendment:{
        upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }],
      },
    }),
    (error) => error?.code === 'GITHUB_INTEGRATION_INDETERMINATE'
      && error?.may_have_mutated === true
      && error?.details?.recovery?.outcome === 'WAITING_EXTERNAL_VERIFICATION',
  );

  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].command, 'project.amend');
  assert.equal(recoveries[0].project_ref, projectRef);
  assert.match(recoveries[0].idempotency_key, /^project-amend-v1:[0-9a-f]{64}$/);
  assert.equal(recoveries[0].request_sha256, recoveries[0].idempotency_key.split(':').at(-1));
  assert.equal(recoveries[0].expected_revision, initialRevision);
  assert.equal(recoveries[0].staged_revision, stagedRevision);
  assert.equal(recoveries[0].pull_request, null);
  assert.deepEqual(recoveries[0].waiting_on, ['github_integration']);
});

test('indeterminate project.amend prescribes authoritative project readback, never orchestration.diagnose', () => {
  const failure = classifyOrchestrationFailure({
    command:'project.amend',
    error_code:'PROJECT_AMEND_ERROR',
    error_class:'internal',
    may_have_mutated:true,
  });
  assert.equal(failure.failure_state, 'INDETERMINATE_EXTERNAL_EFFECT');
  assert.equal(failure.recovery_operation?.command, 'project.inspect');
  assert.equal(failure.recovery_operation?.mode, 'reconcile_authoritative_project_definition');
  assert.equal(failure.automatic_recovery_allowed, false);
  assert.equal(failure.escalation_required, true);
});

test('orchestration.diagnose is prescribed only with an actual durable orchestration run identity', () => {
  const withoutRun = classifyOrchestrationFailure({
    command:'orchestration.advance',
    error_code:'GITHUB_INTEGRATION_INDETERMINATE',
    error_class:'upstream',
    may_have_mutated:true,
  });
  assert.equal(withoutRun.recovery_operation, null);

  const withRun = classifyOrchestrationFailure({
    command:'orchestration.advance',
    error_code:'GITHUB_INTEGRATION_INDETERMINATE',
    error_class:'upstream',
    may_have_mutated:true,
    details:{ run_id:'run:durable-1' },
  });
  assert.equal(withRun.recovery_operation?.command, 'orchestration.diagnose');
  assert.deepEqual(withRun.recovery_operation?.input, { run_id:'run:durable-1' });
});

test('worker boundary preserves bounded nested provider diagnostics across project.amend wrapping', () => {
  const error = new Error('GitHub project definition mutation did not return a confirmed exact revision');
  error.code = 'PROJECT_AUTHORING_MUTATION_UNCONFIRMED';
  error.may_have_mutated = true;
  error.details = {
    result:{ error:'GITHUB_APP_PERMISSION_DENIED', phase:'preflight.auth', may_have_mutated:false },
    may_have_mutated:true,
  };
  const sanitized = sanitizeWorkerBoundaryError('project.amend', error, {
    defaultError:'PROJECT_AMEND_ERROR',
    defaultMessage:'project.amend failed',
    logger:{ error() {} },
  });
  assert.equal(sanitized.code, 'PROJECT_AMEND_ERROR');
  assert.equal(sanitized.details?.diagnostic_error_code, 'GITHUB_APP_PERMISSION_DENIED');
  assert.equal(sanitized.details?.phase, 'preflight.auth');
  assert.equal(sanitized.may_have_mutated, true);
});
