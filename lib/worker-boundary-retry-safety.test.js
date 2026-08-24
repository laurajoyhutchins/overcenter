import { classifyOrchestrationFailure } from 'lib/orchestration-failures.js';
import { workerBoundaryCommandFailure } from 'lib/worker-boundary-errors.js';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

export async function runWorkerBoundaryRetrySafetyTests() {
  const logged = [];
  const safeGithubFailure = workerBoundaryCommandFailure('work.claim', {
    code: 'GITHUB_APP_UPSTREAM_ERROR',
    message: 'temporary GitHub App read failure',
    may_have_mutated: false,
  }, {
    defaultError: 'WORK_CLAIM_ERROR',
    defaultMessage: 'work.claim failed',
    logger: { error(message) { logged.push(JSON.parse(message)); } },
  });

  check(safeGithubFailure.body?.retryable === true,
    'explicit pre-mutation GitHub App claim failure must be retryable');
  check(logged[0]?.failure_kind === 'upstream_provider',
    'GitHub App upstream failure diagnostics must not be mislabeled as application failures');

  const safeLinearFailure = workerBoundaryCommandFailure('work.claim', {
    code: 'LINEAR_UPSTREAM_GRAPHQL',
    message: 'temporary Linear GraphQL failure',
    may_have_mutated: false,
  }, {
    defaultError: 'WORK_CLAIM_ERROR',
    defaultMessage: 'work.claim failed',
    logger: { error() {} },
  });
  const linearRecovery = classifyOrchestrationFailure({
    command: 'work.claim',
    error_code: safeLinearFailure.body?.error,
    error_class: safeLinearFailure.body?.error_class,
    retryable: safeLinearFailure.body?.retryable,
    rejection: safeLinearFailure.body?.rejection,
    may_have_mutated: safeLinearFailure.body?.may_have_mutated,
    details: safeLinearFailure.body?.details,
  });

  check(safeLinearFailure.body?.retryable === true,
    'explicit pre-mutation Linear claim failure must be retryable');
  check(linearRecovery.failure_state === 'TRANSPORT_UNAVAILABLE',
    'retryable pre-mutation upstream claim failure must not escalate as UNKNOWN');
  check(linearRecovery.automatic_recovery_allowed === true,
    'retryable pre-mutation upstream claim failure must permit bounded automatic recovery');
  check(linearRecovery.recovery_operation?.command === 'work.claim',
    'retryable pre-mutation upstream claim failure must recover through the original claim command');

  const unknownMutationFailure = workerBoundaryCommandFailure('work.claim', {
    code: 'GITHUB_APP_UPSTREAM_ERROR',
    message: 'upstream claim failure without mutation-status evidence',
  }, {
    defaultError: 'WORK_CLAIM_ERROR',
    defaultMessage: 'work.claim failed',
    logger: { error() {} },
  });

  check(unknownMutationFailure.body?.retryable === false,
    'claim failure without explicit mutation-status evidence must not be retryable');
  check(unknownMutationFailure.body?.may_have_mutated === true,
    'unknown mutation status must fail closed as possibly mutated');
  check(unknownMutationFailure.body?.recommended_action === 'reconcile_external_effect',
    'unknown mutation status must require reconciliation instead of same-request retry');

  const persistedUnknownMutation = classifyOrchestrationFailure({
    command: 'work.claim',
    error_code: 'LINEAR_UPSTREAM_GRAPHQL',
    error_class: 'upstream',
    retryable: true,
  });
  check(persistedUnknownMutation.failure_state === 'INDETERMINATE_EXTERNAL_EFFECT',
    `persisted upstream failure without mutation evidence must fail closed, got ${persistedUnknownMutation.failure_state}`);
  check(persistedUnknownMutation.automatic_recovery_allowed === false,
    'persisted upstream failure without mutation evidence must not permit same-request retry');
  check(persistedUnknownMutation.recovery_operation?.command === 'orchestration.diagnose',
    'persisted upstream failure without mutation evidence must reconcile before retry');

  return { ok: true, passed: 4, failed: 0, failures: [] };
}
