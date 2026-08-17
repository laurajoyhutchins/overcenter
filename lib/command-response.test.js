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
  'work.settle',
  'github.apply_changeset',
  'github.review_packet',
  'portfolio.reconcile_work_surface',
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
    ['validation failure', 'INVALID_REQUEST', 'validation', false],
    ['stale precondition failure', 'HEAD_MISMATCH', 'precondition', false],
    ['concurrency conflict', 'ALREADY_CLAIMED', 'conflict', false],
    ['idempotency in progress is retryable', 'IDEMPOTENCY_IN_PROGRESS', 'conflict', true],
    ['idempotency conflict is not retryable', 'IDEMPOTENCY_CONFLICT', 'conflict', false],
    ['permission failure', 'GITHUB_APP_PERMISSION_DENIED', 'permission', false],
    ['setup-required failure', 'GITHUB_APP_SETUP_REQUIRED', 'setup', false],
    ['upstream failure', 'GITHUB_UPSTREAM_ERROR', 'upstream', false],
    ['internal failure', 'INTERNAL_ERROR', 'internal', false],
  ];

  for (const [name, code, expectedClass, expectedRetryable] of failureCases) {
    results.push(await run(name, async () => {
      const classification = classifyCommandError(code);
      assert(classification.error_class === expectedClass, `${code} classified as ${classification.error_class}`);
      assert(classification.retryable === expectedRetryable, `${code} retryability mismatch`);
      const response = commandFailure('github.apply_changeset', {
        ok: false,
        error: code,
        message: `${code} fixture`,
      }, { now: () => FIXED_TIME });
      assert(response.body.ok === false, 'failure lost ok=false');
      assert(response.body.command === 'github.apply_changeset', 'failure command missing');
      assert(response.body.schema_version === 'command-response-v1', 'failure schema missing');
      assert(response.body.observed_at === FIXED_TIME, 'failure observed_at mismatch');
      assert(response.body.error === code, 'stable error code changed');
      assert(response.body.message === `${code} fixture`, 'human message changed');
      assert(response.body.error_class === expectedClass, 'failure class mismatch');
      assert(response.body.retryable === expectedRetryable, 'failure retryability mismatch');
      assert(response.body.details && typeof response.body.details === 'object', 'details object missing');
    }));
  }

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

  return {
    ok: results.every((result) => result.ok),
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    tests: results,
  };
}