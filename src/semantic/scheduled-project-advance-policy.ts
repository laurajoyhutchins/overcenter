import type { ProjectAdvanceIntent } from './project-advance-operation';

/**
 * Scheduled execution enters the same graph-native project advancement
 * boundary as any other targeted executor. Scheduling contributes timing,
 * not work identity, lane selection, or a second orchestration protocol.
 */
export type ScheduledProjectAdvanceIntent = ProjectAdvanceIntent;

export type ScheduledProjectAdvanceDispatch<Result = unknown> = (
  command: 'project.advance',
  intent: ScheduledProjectAdvanceIntent,
) => Promise<Result>;

export function dispatchScheduledProjectAdvance<Result>(
  intent: ScheduledProjectAdvanceIntent,
  dispatch: ScheduledProjectAdvanceDispatch<Result>,
): Promise<Result> {
  return dispatch('project.advance', intent);
}

export interface ScheduledProjectAdvanceRuntime<Result = unknown> {
  advance(intent: ScheduledProjectAdvanceIntent): Promise<Result>;
}

export function createScheduledProjectAdvanceRuntime<Result>(
  dispatch: ScheduledProjectAdvanceDispatch<Result>,
): ScheduledProjectAdvanceRuntime<Result> {
  return Object.freeze({
    advance(intent) {
      return dispatchScheduledProjectAdvance(intent, dispatch);
    },
  });
}