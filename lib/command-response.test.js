import {
  COMMAND_RESPONSE_SCHEMA_VERSION,
  classifyCommandError,
  commandFailure,
  commandSuccess,
  executeCommand,
} from 'lib/command-response.js';

const FIXED_TIME = '2026-08-17T15:00:00.000Z';
const COMMANDS = [
  'work.claim',
  'work.checkpoint',
  'work.heartbeat',
  'work.settle',
  'github.apply_changeset',
  'github.delete_branch',
  'github.actions_storage',
  'github.required_checks.ensure',
  'github.branch_policy.reconcile',
  'github.integration.reconcile',
  'github.stack.reconcile',
  'github.default_branch.migrate',
  'github.review_packet',
  'portfolio.reconcile_work_surface',
  'linear.archive',
  'orchestration.start',
  'orchestration.horizon_checkpoint',
  'orchestration.horizon_resolve',
  'orchestration.finish',
  'orchestration.maintain',
  'orchestration.resume_packet',
  'orchestration.status',
];

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

async function run(name, fn) {
  try {
    await fn();
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, error: String(error?.message || error) };
  }
}

function isIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export async function runCommandResponseTests() {
  const results = [];

  for (const command of COMMANDS) {
    results.push(await run(`success envelope: ${command}`, async () => {
      const body = commandSuccess(command, { ok: true, marker: command }, { now: () => FIXED_TIME });
      assert(body.ok === true, 'success lost ok=true');
      assert(body.command === command, 'canonical command changed');
      assert(body.schema_version === 'command-response-v1', 'schema version mismatch');
      assert(body.schema_version === COMMAND_RESPONSE_SCHEMA_VERSION, 'exported schema constant mismatch');
      assert(body.observed_at === FIXED_TIME && isIso(body.observed_at), 'observed_at is not deterministic ISO');
      assert(body.marker === command, 'domain field was not preserved at top level');
    }));
  }

  results.push(await run('idempotent replay success stays top-level', async () => {
    const body = commandSuccess('github.apply_changeset', {
      ok: true,
      commit_sha: 'a'.repeat(40),
      idempotent_replay: true,
    }, { now: () => FIXED_TIME });
    assert(body.idempotent_replay === true, 'replay marker changed');
    assert(body.commit_sha === 'a'.repeat(40), 'domain success field moved');
  }));

  const failureCases = [
    ['validation failure', 'INVALID_REQUEST', 'validation', false, false],
    ['stale SHA is expected rejection', 'HEAD_MISMATCH', 'precondition', false, true],
    ['stale source revision is expected rejection', 'SOURCE_REVISION_MISMATCH', 'precondition', false, true],
    ['stale Linear revision is expected rejection', 'LINEAR_REVISION_MISMATCH', 'precondition', false, true],
    ['already claimed work is expected rejection', 'ALREADY_CLAIMED', 'conflict', false, true],
    ['work state changed is expected rejection', 'WORK_STATE_CHANGED', 'precondition', false, true],
    ['run budget exhausted is expected rejection', 'RUN_BUDGET_EXHAUSTED', 'precondition', false, true],
    ['unregistered run is expected rejection', 'RUN_NOT_REGISTERED', 'precondition', false, true],
    ['run scope violation is expected rejection', 'RUN_SCOPE_VIOLATION', 'precondition', false, true],
    ['heartbeat hard limit is expected rejection', 'HEARTBEAT_LIMIT_REACHED', 'precondition', false, true],
    ['heartbeat without progress is expected rejection', 'NO_PROGRESS_HEARTBEAT', 'precondition', false, true],
    ['run with active lease cannot finish', 'RUN_HAS_ACTIVE_LEASE', 'precondition', false, true],
    ['horizon precondition changed is expected rejection', 'HORIZON_PRECONDITION_CHANGED', 'precondition', false, true],
    ['run not active is expected rejection', 'RUN_NOT_ACTIVE', 'precondition', false, true],
    ['run not found is not_found', 'RUN_NOT_FOUND', 'not_found', false, false],
    ['idempotency in progress is retryable rejection', 'IDEMPOTENCY_IN_PROGRESS', 'conflict', true, true],
    ['idempotency conflict is non-retryable rejection', 'IDEMPOTENCY_CONFLICT', 'conflict', false, true],
    ['lease invalid is malformed or unknown authority, not rejection', 'LEASE_INVALID', 'precondition', false, false],
    ['claim indeterminate is not rejection', 'CLAIM_INDETERMINATE', 'upstream', true, false],
    ['branch delete indeterminate is retryable', 'BRANCH_DELETE_INDETERMINATE', 'upstream', true, false],
    ['required checks indeterminate is retryable', 'GITHUB_REQUIRED_CHECKS_INDETERMINATE', 'upstream', true, false],
    ['linear archive indeterminate is retryable', 'LINEAR_ARCHIVE_INDETERMINATE', 'upstream', true, false],
    ['portfolio reconcile indeterminate is retryable', 'PORTFOLIO_RECONCILE_INDETERMINATE', 'upstream', true, false],
    ['observational head movement is not rejection', 'HEAD_MOVED_DURING_INSPECTION', 'precondition', false, false],
    ['permission failure', 'GITHUB_APP_PERMISSION_DENIED', 'permission', false, false],
    ['setup-required failure', 'GITHUB_APP_SETUP_REQUIRED', 'setup', false, false],
    ['integration policy missing is expected precondition rejection', 'GITHUB_INTEGRATION_POLICY_NOT_CONFIGURED', 'precondition', false, true],
    ['integration stale authority is expected precondition rejection', 'GITHUB_INTEGRATION_RECOMPUTE_REQUIRED', 'precondition', false, true],
    ['integration transport ambiguity is retryable upstream', 'GITHUB_INTEGRATION_INDETERMINATE', 'upstream', true, false],
    ['integration result expiry is not found', 'GITHUB_INTEGRATION_RESULT_EXPIRED', 'not_found', false, false],
    ['upstream failure', 'GITHUB_UPSTREAM_ERROR', 'upstream', false, false],
    ['internal failure', 'INTERNAL_ERROR', 'internal', false, false],
  ];

  for (const [name, code, expectedClass, expectedRetryable, expectedRejection] of failureCases) {
    results.push(await run(name, async () => {
      const classification = classifyCommandError(code);
      assert(classification.error_class === expectedClass, `${code} classified as ${classification.error_class}`);
      assert(classification.retryable === expectedRetryable, `${code} retryability mismatch`);
      assert(classification.rejection === expectedRejection, `${code} rejection mismatch`);
      const response = commandFailure('github.apply_changeset', {
        ok: false,
        error: code,
        message: `${code} fixture`,
      }, { now: () => FIXED_TIME });
      assert(response.body.ok === false, 'failure lost ok=false');
      assert(response.body.command === 'github.apply_changeset', 'failure command missing');
      assert(response.body.schema_version === 'command-response-v1', 'failure schema missing');
      assert(response.body.observed_at === FIXED_TIME, 'failure observed_at mismatch');
      assert(response.body.error === code, 'stable compatibility error code changed');
      assert(response.body.error_code === code, 'canonical error_code missing');
      assert(response.body.message === `${code} fixture`, 'human message changed');
      assert(response.body.error_class === expectedClass, 'failure class mismatch');
      assert(response.body.retryable === expectedRetryable, 'failure retryability mismatch');
      assert(response.body.rejection === expectedRejection, 'failure rejection mismatch');
      assert(typeof response.body.may_have_mutated === 'boolean', 'may_have_mutated is not stable boolean');
      assert(Object.prototype.hasOwnProperty.call(response.body, 'recommended_action'), 'recommended_action field missing');
      assert(response.body.details && typeof response.body.details === 'object', 'details object missing');
    }));
  }

  results.push(await run('command-specific rejection semantics stay centralized', async () => {
    const changeset = commandFailure('github.apply_changeset', { ok: false, error: 'HEAD_MISMATCH', message: 'stale mutation head' }, { now: () => FIXED_TIME });
    const requiredChecksPermission = commandFailure('github.required_checks.ensure', { ok: false, error: 'GITHUB_APP_PERMISSION_DENIED', message: 'administration permission not granted' }, { now: () => FIXED_TIME });
    const requiredChecksUnknown = commandFailure('github.required_checks.ensure', { ok: false, error: 'GITHUB_REQUIRED_CHECK_UNKNOWN', message: 'unknown required check' }, { now: () => FIXED_TIME });
    const review = commandFailure('github.review_packet', { ok: false, error: 'HEAD_MISMATCH', message: 'stale observation guard' }, { now: () => FIXED_TIME });
    const capture = commandFailure('object.capture', { ok: false, error: 'OBJECT_ID_CONFLICT', message: 'capture identity conflict' }, { now: () => FIXED_TIME });
    const verified = commandFailure('object.get_verified', { ok: false, error: 'OBJECT_ID_CONFLICT', message: 'verification identity conflict' }, { now: () => FIXED_TIME });
    assert(changeset.body.rejection === true, 'changeset stale head lost rejection semantics');
    assert(requiredChecksPermission.body.rejection === true, 'required-check permission boundary is not an expected rejection');
    assert(requiredChecksUnknown.body.rejection === true, 'unknown required check is not an expected rejection');
    assert(review.body.rejection === false, 'review observation inherited mutation rejection semantics');
    assert(capture.body.rejection === true, 'capture identity conflict not classified as rejection');
    assert(verified.body.rejection === false, 'verified observation conflict was classified as rejection');
  }));

  results.push(await run('canonical details preserve legacy flattened fields', async () => {
    const response = commandFailure('github.apply_changeset', {
      ok: false,
      error: 'HEAD_MISMATCH',
      message: 'target branch changed',
      expected_head: 'a'.repeat(40),
      actual_head: 'b'.repeat(40),
      branch: 'agent/test',
    }, { now: () => FIXED_TIME, statusForFailure: () => 409, flattenDetails: true });
    assert(response.status === 409, 'explicit legacy HTTP status changed');
    assert(response.body.details.expected_head === 'a'.repeat(40), 'expected_head missing from canonical details');
    assert(response.body.details.actual_head === 'b'.repeat(40), 'actual_head missing from canonical details');
    assert(response.body.details.branch === 'agent/test', 'branch missing from canonical details');
    assert(response.body.expected_head === response.body.details.expected_head, 'legacy expected_head removed');
    assert(response.body.actual_head === response.body.details.actual_head, 'legacy actual_head removed');
    assert(response.body.branch === response.body.details.branch, 'legacy branch removed');
  }));

  results.push(await run('executeCommand envelopes thrown domain errors', async () => {
    const error = new Error('authoritative state changed');
    error.code = 'WORK_STATE_CHANGED';
    error.details = { expected_revision: 'rev-1', actual_revision: 'rev-2' };
    const response = await executeCommand('work.settle', async () => { throw error; }, {
      now: () => FIXED_TIME,
      statusForFailure: () => 409,
      flattenDetails: true,
    });
    assert(response.status === 409, 'thrown error status changed');
    assert(response.body.error_class === 'precondition', 'thrown error class mismatch');
    assert(response.body.details.actual_revision === 'rev-2', 'thrown details missing');
    assert(response.body.actual_revision === 'rev-2', 'legacy thrown detail not flattened');
  }));

  results.push(await run('portfolio batch success preserves item-level rejection', async () => {
    const body = commandSuccess('portfolio.reconcile_work_surface', {
      ok: true,
      summary: { rejected: 1 },
      items: [{ result: 'rejected', reason: 'SOURCE_REVISION_MISMATCH' }],
      idempotent_replay: false,
    }, { now: () => FIXED_TIME });
    assert(body.ok === true, 'batch was promoted to command failure');
    assert(body.items[0].result === 'rejected', 'item result changed');
    assert(body.items[0].reason === 'SOURCE_REVISION_MISMATCH', 'item reason changed');
  }));

  results.push(await run('review packet partial capability remains successful', async () => {
    const body = commandSuccess('github.review_packet', {
      ok: true,
      protection: {
        available: false,
        policy_surfaces: {
          rulesets: {
            available: false,
            unavailable: { reason: 'permission_denied', error: 'GITHUB_PERMISSION_DENIED' },
          },
        },
      },
    }, { now: () => FIXED_TIME });
    assert(body.ok === true, 'partial packet became command failure');
    assert(body.protection.available === false, 'partial capability marker changed');
    assert(body.protection.policy_surfaces.rulesets.unavailable.reason === 'permission_denied', 'unavailable evidence changed');
    assert(!Object.prototype.hasOwnProperty.call(body, 'idempotent_replay'), 'read-only command invented replay marker');
  }));

  results.push(await run('optional run_id is additive on success and failure', async () => {
    const runId = 'ff-run-20260817';
    const success = commandSuccess('github.review_packet', { ok: true, marker: 'x' }, { now: () => FIXED_TIME, run_id: runId });
    const failure = commandFailure('github.delete_branch', { ok: false, error: 'HEAD_MISMATCH', message: 'stale' }, { now: () => FIXED_TIME, run_id: runId });
    assert(success.run_id === runId, 'success run_id missing');
    assert(failure.body.run_id === runId, 'failure run_id missing');
    assert(success.schema_version === 'command-response-v1' && failure.body.schema_version === 'command-response-v1', 'additive run_id bumped schema');
  }));

  return {
    ok: results.every((result) => result.ok),
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    tests: results,
  };
}