import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  RUNNER_EXECUTION_LEASE_SCHEMA,
  parseRunnerExecutionLease,
} from '../src/transport/gcp-runner-launcher.ts';
import {
  assessWarmRunnerOperationalTrace,
  warmRunnerOperationalEvent,
  warmRunnerOperationalIdentity,
  type WarmRunnerOperationalEvent,
  type WarmRunnerOperationalStage,
} from '../src/transport/warm-runner-operational-observation.ts';

const lease = parseRunnerExecutionLease({
  schema: RUNNER_EXECUTION_LEASE_SCHEMA,
  repository: 'laurajoyhutchins/arcata',
  repository_id: 1_402_666_660,
  owner_id: 219_002_713,
  job_id: 111_891_233_183,
  runner_label: 'overcenter-gcp-warm-123-check',
});
const identity = warmRunnerOperationalIdentity(
  'project-6b810532-a302-48dc-b56',
  'overcenter-gce-runners',
  lease,
  'pubsub-message-123',
  'attempt-123',
);
const at = '2026-10-09T18:00:00.000Z';

function events(stages: readonly WarmRunnerOperationalStage[]): WarmRunnerOperationalEvent[] {
  return stages.map((stage, index) => warmRunnerOperationalEvent(identity, index + 1, stage, at));
}

const success = [
  'lease_received',
  'jit_authorized',
  'container_started',
  'container_exit_zero',
  'container_absent_readback',
  'workspace_absent_readback',
  'ack_request_accepted',
] as const;

test('a complete host trace is a diagnostic, never authoritative provider settlement', () => {
  const result = assessWarmRunnerOperationalTrace(identity, events(success));
  assert.deepEqual(result, {
    state: 'reported-cleanup-and-ack-request',
    settlement_authoritative: false,
  });
  assert.deepEqual(
    assessWarmRunnerOperationalTrace(identity, [...events(success), ...events(success)]),
    result,
  );
});

test('stale queued job can only report ACK after workspace removal', () => {
  assert.deepEqual(
    assessWarmRunnerOperationalTrace(
      identity,
      events(['lease_received', 'job_stale', 'workspace_absent_readback', 'ack_request_accepted']),
    ),
    { state: 'reported-cleanup-and-ack-request', settlement_authoritative: false },
  );
  assert.equal(
    assessWarmRunnerOperationalTrace(
      identity,
      events(['lease_received', 'job_stale', 'ack_request_accepted']),
    ).state,
    'incomplete',
  );
});

test('missing or reordered cleanup observations never look complete', () => {
  for (const stages of [
    success.filter((stage) => stage !== 'container_absent_readback'),
    success.filter((stage) => stage !== 'workspace_absent_readback'),
    success.filter((stage) => stage !== 'container_exit_zero'),
    success.filter((stage) => stage !== 'ack_request_accepted'),
    [
      'lease_received',
      'jit_authorized',
      'container_started',
      'container_exit_zero',
      'workspace_absent_readback',
      'container_absent_readback',
      'ack_request_accepted',
    ],
    [...success.slice(0, -1), 'ack_request_uncertain'],
    [...success.slice(0, -1), 'execution_failed'],
  ] as readonly (readonly WarmRunnerOperationalStage[])[]) {
    assert.equal(assessWarmRunnerOperationalTrace(identity, events(stages)).state, 'incomplete');
  }
  assert.equal(assessWarmRunnerOperationalTrace(identity, []).state, 'incomplete');
});

test('wrong attempt, wrong job, same-sequence conflict, and partial log streams fail closed', () => {
  const complete = events(success);
  assert.deepEqual(
    assessWarmRunnerOperationalTrace(identity, [
      ...complete.slice(0, 2),
      { ...complete[2]!, job_id: 999 },
      ...complete.slice(3),
    ]),
    { state: 'contradictory', reason: 'WARM_RUNNER_TRACE_IDENTITY_OR_SHAPE_MISMATCH' },
  );
  assert.equal(
    assessWarmRunnerOperationalTrace(identity, [
      ...complete,
      { ...complete[1]!, stage: 'job_stale' },
    ]).state,
    'contradictory',
  );
  assert.equal(
    assessWarmRunnerOperationalTrace(identity, [
      { ...complete[0]!, attempt_id: 'other-attempt' },
      ...complete.slice(1),
    ]).state,
    'contradictory',
  );
  assert.equal(assessWarmRunnerOperationalTrace(identity, complete.slice(1)).state, 'incomplete');
  assert.equal(
    assessWarmRunnerOperationalTrace(identity, [
      ...complete.slice(0, 4),
      { ...complete[4]!, sequence: 22 },
      ...complete.slice(5),
    ]).state,
    'incomplete',
  );
});

test('the host verifies Docker and workspace absence before Pub/Sub ACK', () => {
  const source = readFileSync(
    new URL('../src/transport/gce-runner-agent.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /dockerRequest\('GET', '\/v1\.45\/containers\/' \+ id \+ '\/json'\)/);
  assert.match(source, /readback\.statusCode !== 404/);
  assert.match(source, /observe\('container_absent_readback'\)/);
  assert.match(source, /await lstat\(workspace\)/);
  assert.match(source, /observe\('workspace_absent_readback'\)/);
  assert.match(source, /if \(completed\) \{[\s\S]*await acknowledge\(environment, pulled\.ackId\)/);
  assert.doesNotMatch(source, /dockerRequest\('DELETE',[^\n]+\.catch\(\(\) => undefined\)/);
});

test('JSONL reporter groups attempts, tolerates unrelated host logs, and exposes gaps', async () => {
  const { reportWarmRunnerEvents } = await import('../src/transport/report-warm-runner-events.ts');
  const trace = events(success);
  const report = reportWarmRunnerEvents(
    [
      'Docker service ready',
      JSON.stringify({ event: 'unrelated' }),
      ...trace.map(JSON.stringify),
    ].join('\n'),
  );
  assert.equal(report.attempts.length, 1);
  assert.equal(report.attempts[0]?.result.state, 'reported-cleanup-and-ack-request');
  assert.equal(report.settlement_authoritative, false);
  assert.equal(report.source, 'unverified-host-stdout');

  const missing = reportWarmRunnerEvents(trace.slice(0, -1).map(JSON.stringify).join('\n'));
  assert.equal(missing.attempts[0]?.result.state, 'incomplete');
  const wrongSchema = reportWarmRunnerEvents(
    [...trace.map(JSON.stringify), JSON.stringify({ ...trace[0], schema: 'wrong' })].join('\n'),
  );
  assert.equal(wrongSchema.malformed_operational_events, 1);
  assert.equal(reportWarmRunnerEvents('unrelated\n').attempts.length, 0);
});
