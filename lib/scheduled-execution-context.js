import { createPostgresOrchestrationRunService } from 'lib/orchestration-runs.js';
import { scheduledCycleIdForParticipant, scheduledCycleParticipants, scheduledRunId } from 'lib/scheduled-cycle-completeness.js';

const SCHEMA = 'scheduled-execution-context-v1';
const TEAM = 'Ljh-projects';
const LANE_BY_PARTICIPANT = Object.freeze({
  'portfolio-dispatcher': null,
  'repository-implementation': 'lane:repo-implementation',
  'source-data-implementation': 'lane:source-implementation',
  'exact-head-verification': 'lane:verification',
  'portfolio-integration': 'lane:integration',
});

function err(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function participantFor(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  const participant = scheduledCycleParticipants.find((candidate) => candidate.id === id) || null;
  if (!participant) throw err('REQUEST_INVALID', 'participant is not an ordinary scheduled participant', { field:'participant', participant:id || null });
  return participant;
}

export function createScheduledExecutionContextService({ runs = null, now = () => new Date().toISOString() } = {}) {
  const runService = runs || createPostgresOrchestrationRunService();
  if (!runService || typeof runService.start !== 'function') throw new TypeError('runs.start is required');

  async function bootstrap(input = {}) {
    const allowed = new Set(['participant']);
    const unknown = Object.keys(input || {}).filter((key) => !allowed.has(key));
    if (unknown.length) throw err('REQUEST_INVALID', 'scheduled bootstrap accepts participant only', { fields:unknown.sort() });
    const participant = participantFor(input?.participant);
    const observedAt = now();
    const cycleId = scheduledCycleIdForParticipant(participant.id, observedAt);
    const runId = scheduledRunId(cycleId, participant.id);
    const lane = LANE_BY_PARTICIPANT[participant.id] || null;
    const scope = {
      team: TEAM,
      lanes: lane ? [lane] : [],
      repositories: [],
      direction: `Scheduled ${participant.title} execution`,
    };
    const run = await runService.start({
      run_id:runId,
      worker:participant.title,
      mode:'scheduled',
      continuation_key:`scheduled:${participant.id}`,
      scope,
    });
    return {
      ok:true,
      schema:SCHEMA,
      participant:participant.id,
      participant_title:participant.title,
      automation_id:participant.automation_id,
      cycle_id:cycleId,
      run_id:runId,
      lane,
      scope,
      run,
      work_authority_changed:false,
    };
  }

  return { bootstrap };
}

export function createPostgresScheduledExecutionContextService(options = {}) {
  return createScheduledExecutionContextService({
    runs: options.runs || createPostgresOrchestrationRunService(options),
    now: options.now,
  });
}

export function statusForScheduledExecutionContextError(error) {
  return String(error?.code || '') === 'REQUEST_INVALID' ? 400 : 500;
}

export const scheduledExecutionContextConfig = Object.freeze({ schema:SCHEMA, team:TEAM, lanes:LANE_BY_PARTICIPANT });
