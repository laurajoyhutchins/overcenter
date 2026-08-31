import { dispatchScheduledProjectAdvance, type ScheduledProjectAdvanceIntent } from '../src/semantic/scheduled-project-advance-policy';

const scheduledIntent: ScheduledProjectAdvanceIntent = {
  project_ref: 'github:laurajoyhutchins/overcenter',
};
void scheduledIntent;

const legacyLaneIntent: ScheduledProjectAdvanceIntent = {
  project_ref: 'github:laurajoyhutchins/overcenter',
  // @ts-expect-error lane identity is outside the scheduled graph-native semantic boundary
  lane: 'lane:source-implementation',
};
void legacyLaneIntent;

const legacyWorkIntent: ScheduledProjectAdvanceIntent = {
  project_ref: 'github:laurajoyhutchins/overcenter',
  // @ts-expect-error work identity is derived by Overcenter from the authoritative graph
  work_ref: 'LJH-123',
};
void legacyWorkIntent;

const scheduledDispatchResult = dispatchScheduledProjectAdvance(scheduledIntent, async (command, intent) => {
  const sameCommand: 'project.advance' = command;
  const sameIntent: ScheduledProjectAdvanceIntent = intent;
  void sameCommand;
  void sameIntent;
  return { ok: true as const };
});
void scheduledDispatchResult;
