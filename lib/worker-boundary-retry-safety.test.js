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

  const inferredSafeClaimFailure = workerBoundaryCommandFailure('work.claim', {
    code: 'LINEAR_UPSTREAM_GRAPHQL',
    message: 'upstream claim read failed without explicit mutation-status evidence',
  }, {
    defaultError: 'WORK_CLAIM_ERROR',
    defaultMessage: 'work.claim failed',
    logger: { error() {} },
  });

  check(inferredSafeClaimFailure.body?.retryable === true,
    'work.claim upstream failures must inherit the command-level no-authority-mutation contract');
  check(inferredSafeClaimFailure.body?.may_have_mutated === false,
    'work.claim upstream failures must be marked pre-authority-mutation by command contract');
  check(inferredSafeClaimFailure.body?.recommended_action === 'retry_same_request',
    'command-safe claim failure must use deterministic same-request retry');

  const unknownSettlementFailure = workerBoundaryCommandFailure('work.settle', {
    code: 'LINEAR_UPSTREAM_GRAPHQL',
    message: 'settlement upstream failure without mutation-status evidence',
  }, {
    defaultError: 'WORK_SETTLE_ERROR',
    defaultMessage: 'work.settle failed',
    logger: { error() {} },
  });
  check(unknownSettlementFailure.body?.retryable === false,
    'commands without a no-authority-mutation contract must remain non-retryable when mutation status is unknown');
  check(unknownSettlementFailure.body?.may_have_mutated === true,
    'unknown settlement mutation status must fail closed as possibly mutated');

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

  return { ok: true, passed: 5, failed: 0, failures: [] };
}
