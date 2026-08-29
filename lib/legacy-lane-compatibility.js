import { PRODUCTIVE_STAGES } from './work-lifecycle.js';

// Compatibility projection only. Canonical graph execution is transition-scoped and
// must not derive executor identity or lifecycle meaning from these Linear lanes.
const STAGE_SET = new Set(PRODUCTIVE_STAGES);

function normalizeStage(value) {
  const stage = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!STAGE_SET.has(stage)) {
    const error = new Error('stage must be a productive lifecycle stage');
    error.code = 'INVALID_STAGE';
    error.details = { field:'stage', value:value ?? null };
    throw error;
  }
  return stage;
}

export const LEGACY_LANE_BY_STAGE = Object.freeze({
  ENABLE: 'lane:enable',
  ACQUIRE: 'lane:source-implementation',
  EXECUTE: 'lane:repo-implementation',
  COMMIT: 'lane:integration',
  CONFIRM: 'lane:verification',
});

export const STAGE_BY_LEGACY_LANE = Object.freeze(Object.fromEntries(
  Object.entries(LEGACY_LANE_BY_STAGE).map(([stage, lane]) => [lane, stage]),
));

export function legacyProjectionForStage(stage, currentLane = null) {
  if (stage === 'DONE') return Object.freeze({ state:'Done', lane:currentLane, participant:null });
  const normalized = normalizeStage(stage);
  return Object.freeze({
    state:'Todo',
    lane:LEGACY_LANE_BY_STAGE[normalized],
    participant:normalized.toLowerCase(),
  });
}