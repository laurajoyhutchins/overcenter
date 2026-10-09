import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  assessWarmRunnerOperationalTrace,
  WARM_RUNNER_OPERATIONAL_EVENT_SCHEMA,
  type WarmRunnerOperationalEvent,
  type WarmRunnerOperationalIdentity,
} from './warm-runner-operational-observation.ts';

interface TraceReport {
  identity: WarmRunnerOperationalIdentity;
  result: ReturnType<typeof assessWarmRunnerOperationalTrace>;
  event_count: number;
}

// Accepts an untrusted host JSONL export. A log is diagnostic, not a
// certified GCP/PubSub observer and must never settle an Overcenter effect.
export function reportWarmRunnerEvents(input: string): {
  schema: 'overcenter-warm-runner-diagnostic-report/v1';
  source: 'unverified-host-stdout';
  attempts: TraceReport[];
  malformed_operational_events: number;
  settlement_authoritative: false;
} {
  const grouped = new Map<string, WarmRunnerOperationalEvent[]>();
  let malformed = 0;
  for (const line of input.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      // Docker stdout may contain non-JSON text; absence of an event never
      // becomes positive evidence.
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    if (event.event !== 'warm_runner_operational_observation') continue;
    if (
      event.schema !== WARM_RUNNER_OPERATIONAL_EVENT_SCHEMA ||
      !['project_id', 'subscription', 'repository', 'message_id', 'attempt_id'].every(
        (key) => typeof event[key] === 'string' && String(event[key]).length > 0,
      ) ||
      !['repository_id', 'owner_id', 'job_id'].every(
        (key) => Number.isSafeInteger(event[key]) && Number(event[key]) > 0,
      )
    ) {
      malformed += 1;
      continue;
    }
    const typed = event as unknown as WarmRunnerOperationalEvent;
    const key = JSON.stringify([
      typed.project_id,
      typed.subscription,
      typed.repository,
      typed.repository_id,
      typed.owner_id,
      typed.job_id,
      typed.message_id,
      typed.attempt_id,
    ]);
    const rows = grouped.get(key) ?? [];
    rows.push(typed);
    grouped.set(key, rows);
  }
  const attempts = [...grouped.values()].map((events): TraceReport => {
    const first = events[0]!;
    const identity: WarmRunnerOperationalIdentity = {
      project_id: first.project_id,
      subscription: first.subscription,
      repository: first.repository,
      repository_id: first.repository_id,
      owner_id: first.owner_id,
      job_id: first.job_id,
      message_id: first.message_id,
      attempt_id: first.attempt_id,
    };
    return {
      identity,
      result: assessWarmRunnerOperationalTrace(identity, events),
      event_count: events.length,
    };
  });
  attempts.sort((a, b) =>
    JSON.stringify(a.identity).localeCompare(JSON.stringify(b.identity)),
  );
  return {
    schema: 'overcenter-warm-runner-diagnostic-report/v1',
    source: 'unverified-host-stdout',
    attempts,
    malformed_operational_events: malformed,
    settlement_authoritative: false,
  };
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) {
    console.error('usage: node --experimental-strip-types src/transport/report-warm-runner-events.ts <host-stdout.jsonl>');
    process.exitCode = 2;
  } else {
    const report = reportWarmRunnerEvents(readFileSync(file, 'utf8'));
    console.log(JSON.stringify(report, null, 2));
    if (
      report.malformed_operational_events > 0 ||
      report.attempts.length === 0 ||
      report.attempts.some((attempt) => attempt.result.state !== 'reported-cleanup-and-ack-request')
    ) {
      process.exitCode = 2;
    }
  }
}
