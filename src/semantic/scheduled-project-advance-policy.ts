import type { ProjectAdvanceIntent } from './project-advance-operation';

/**
 * Scheduled execution enters the same graph-native project advancement
 * boundary as any other targeted executor. Scheduling contributes timing,
 * not work identity, lane selection, or a second orchestration protocol.
 */
export type ScheduledProjectAdvanceIntent = ProjectAdvanceIntent;