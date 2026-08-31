import type { ScheduledProjectAdvanceIntent } from '../src/semantic/scheduled-project-advance-policy';

const scheduledIntent: ScheduledProjectAdvanceIntent = {
  project_ref: 'github:laurajoyhutchins/overcenter',
};
void scheduledIntent;

// Scheduled execution selects project graph work, never a legacy Linear lane.
// @ts-expect-error lane identity is outside the scheduled graph-native semantic boundary
const legacyLaneIntent: ScheduledProjectAdvanceIntent = {
  project_ref: 'github:laurajoyhutchins/overcenter',
  lane: 'lane:source-implementation',
};
void legacyLaneIntent;

// Scheduled execution does not accept caller-selected work items.
// @ts-expect-error work identity is derived by Overcenter from the authoritative graph
const legacyWorkIntent: ScheduledProjectAdvanceIntent = {
  project_ref: 'github:laurajoyhutchins/overcenter',
  work_ref: 'LJH-123',
};
void legacyWorkIntent;