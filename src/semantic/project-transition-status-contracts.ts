export const PROJECT_TRANSITION_STATES = ['DONE', 'OFF_NOMINAL', 'WAITING', 'READY'] as const;
export type ProjectTransitionState = (typeof PROJECT_TRANSITION_STATES)[number];

export interface ProjectTransitionLifecycleStatus {
  current_stage: string;
  next_stage: string | null;
  condition: string;
  command: string | null;
  complete: boolean;
}

export interface ProjectTransitionStatus {
  id: string;
  priority: number;
  state: ProjectTransitionState;
  requires: readonly string[];
  unmet_requirements: readonly string[];
  lifecycle: ProjectTransitionLifecycleStatus;
  executor: Readonly<Record<string, unknown>>;
}

export interface ProjectTransitionStatusProjection {
  project: {
    available: boolean;
    schema: 'project-transition-status-v1';
    project_ref: string | null;
    authority: Readonly<Record<string, unknown>> | null;
    complete: boolean | null;
    frontier: readonly string[];
    error_code?: string;
  };
  project_transitions: readonly ProjectTransitionStatus[];
}