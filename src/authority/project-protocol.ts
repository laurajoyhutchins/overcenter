import type { JudgmentFrontierDecision } from './judgment-frontier.ts';

export type ProjectVisibleState =
  | 'READY'
  | 'EXECUTING'
  | 'WAITING'
  | 'BLOCKED'
  | 'RECOVERY_REQUIRED'
  | 'DONE'
  | 'AGENT_EXECUTION_REQUIRED';

export interface ProjectAdvanceResult {
  authority_head: string;
  state: ProjectVisibleState;
  obligation_id?: string;
  run_id?: string;
  claimed_revision?: string;
  assignment_sha256?: string;
  dispatch?: JudgmentFrontierDecision;
}

export interface ProjectSubmitResult {
  authority_head: string;
  obligation_id: string;
  run_id: string;
  claimed_revision: string;
  assignment_sha256?: string;
  output_sha256?: string;
  disposition: 'DONE' | 'READY' | 'RECOVERY_REQUIRED';
  verified: boolean;
  settlement_commit: string | null;
  already_settled: boolean;
}

export interface ProjectProtocol<AdvanceInput, SubmitInput> {
  advance(input: AdvanceInput): ProjectAdvanceResult | Promise<ProjectAdvanceResult>;
  submit(input: SubmitInput): ProjectSubmitResult | Promise<ProjectSubmitResult>;
}

export function projectAdvanceResult(value: ProjectAdvanceResult): ProjectAdvanceResult {
  return {
    authority_head: value.authority_head,
    state: value.state,
    ...(value.obligation_id === undefined ? {} : { obligation_id: value.obligation_id }),
    ...(value.run_id === undefined ? {} : { run_id: value.run_id }),
    ...(value.claimed_revision === undefined
      ? {}
      : { claimed_revision: value.claimed_revision }),
    ...(value.assignment_sha256 === undefined
      ? {}
      : { assignment_sha256: value.assignment_sha256 }),
    ...(value.dispatch === undefined ? {} : { dispatch: value.dispatch }),
  };
}

export function projectSubmitResult(value: ProjectSubmitResult): ProjectSubmitResult {
  return {
    authority_head: value.authority_head,
    obligation_id: value.obligation_id,
    run_id: value.run_id,
    claimed_revision: value.claimed_revision,
    ...(value.assignment_sha256 === undefined
      ? {}
      : { assignment_sha256: value.assignment_sha256 }),
    ...(value.output_sha256 === undefined ? {} : { output_sha256: value.output_sha256 }),
    disposition: value.disposition,
    verified: value.verified,
    settlement_commit: value.settlement_commit,
    already_settled: value.already_settled,
  };
}
