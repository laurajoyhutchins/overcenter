export const WORK_SETTLEMENT_DISPOSITIONS = ['completed', 'requeue', 'blocked'] as const;
export type WorkSettlementDisposition = (typeof WORK_SETTLEMENT_DISPOSITIONS)[number];

export const WORK_REQUEUE_CLASSES = [
  'resume_progress',
  'retry_runtime_failure',
  'wait_for_observable_change',
  'stale_candidate',
  'insufficient_execution_window',
] as const;
export type WorkRequeueClass = (typeof WORK_REQUEUE_CLASSES)[number];

export const RUN_MODES = ['scheduled', 'interactive'] as const;
export type OrchestrationRunMode = (typeof RUN_MODES)[number];

export const RUN_FINISH_DISPOSITIONS = ['completed', 'clean-stop', 'blocked', 'failed', 'no-work'] as const;
export type RunFinishDisposition = (typeof RUN_FINISH_DISPOSITIONS)[number];

export const LIVE_LEASE_STATUSES = ['claiming', 'active', 'settling'] as const;
export type LiveLeaseStatus = (typeof LIVE_LEASE_STATUSES)[number];
