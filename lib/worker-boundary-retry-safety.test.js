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

  return { ok: true, passed: 2, failed: 0, failures: [] };
}
