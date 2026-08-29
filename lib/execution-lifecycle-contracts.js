export const PRODUCTIVE_STAGES = ['ENABLE', 'ACQUIRE', 'EXECUTE', 'COMMIT', 'CONFIRM'];
export const OPERATING_CONDITIONS = ['NOMINAL', 'HOLD', 'FAULT', 'INDETERMINATE', 'OPERATOR_HOLD'];
export const WORK_SETTLEMENT_DISPOSITIONS = ['completed', 'requeue', 'blocked'];
export const WORK_REQUEUE_CLASSES = [
    'resume_progress',
    'retry_runtime_failure',
    'wait_for_observable_change',
    'stale_candidate',
    'insufficient_execution_window',
];
export const RUN_MODES = ['scheduled', 'interactive'];
export const RUN_FINISH_DISPOSITIONS = ['completed', 'clean-stop', 'blocked', 'failed', 'no-work'];
export const LIVE_LEASE_STATUSES = ['claiming', 'active', 'settling'];
