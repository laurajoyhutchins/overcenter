import type { Assignment } from '../execution/assignment-capsule.ts';
import type { SourceAssignment } from '../source/source-obligation.ts';
import type { JudgmentFrontierDecision } from './judgment-frontier.ts';

export type ProjectVisibleState =
  | 'READY'
  | 'EXECUTING'
  | 'WAITING'
  | 'BLOCKED'
  | 'RECOVERY_REQUIRED'
  | 'DONE'
  | 'AGENT_EXECUTION_REQUIRED';

export type ProjectAssignment = Assignment | SourceAssignment;

export interface ProjectContext {
  repository_id: number;
  repository_full_name: string;
  source_revision: string;
}

export interface ProjectAdvanceResult {
  authority_head: string;
  state: ProjectVisibleState;
  obligation_id?: string;
  run_id?: string;
  claimed_revision?: string;
  assignment_sha256?: string;
  assignment?: ProjectAssignment;
  dispatch?: JudgmentFrontierDecision;
}
