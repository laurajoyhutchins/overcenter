import type { LeaseId, RunId, WorkRef } from '../src/semantic/semantic-identities.js';
import {
  type ExecutionAuthority,
  type ExecutionAuthorityLocator,
  type ExecutionAuthorityStore,
  type ProjectTransitionExecutionAuthority,
} from '../src/semantic/execution-authority-contracts.js';
import {
  LEGACY_WORK_EXECUTION_GATES,
  type LegacyWorkExecutionAuthority,
  type LegacyWorkExecutionGate,
} from '../src/semantic/legacy-work-execution-authority-contracts.js';
import {
  LIVE_LEASE_STATUSES,
  RUN_FINISH_DISPOSITIONS,
  RUN_MODES,
  WORK_REQUEUE_CLASSES,
  WORK_SETTLEMENT_DISPOSITIONS,
  type OrchestrationRunMode,
  type WorkSettlementDisposition,
} from '../src/semantic/execution-lifecycle-contracts.js';

const implementationGate: LegacyWorkExecutionGate = 'lane:repo-implementation';
const verificationGate: LegacyWorkExecutionGate = LEGACY_WORK_EXECUTION_GATES[4];
void implementationGate;
void verificationGate;

// @ts-expect-error legacy work gates remain a closed compatibility-only vocabulary
const impossibleGate: LegacyWorkExecutionGate = 'lane:imaginary';
void impossibleGate;

const byToken: ExecutionAuthorityLocator = { lease_token: 'opaque-capability' };
const byRef: ExecutionAuthorityLocator = { lease_ref: '00000000-0000-4000-8000-000000000000' };
void byToken;
void byRef;

// @ts-expect-error authority locator must choose exactly one mechanism
const ambiguousLocator: ExecutionAuthorityLocator = { lease_token: 'token', lease_ref: 'ref' };
void ambiguousLocator;

// @ts-expect-error authority locator cannot omit both mechanisms
const missingLocator: ExecutionAuthorityLocator = {};
void missingLocator;

declare const leaseId: LeaseId;
declare const runId: RunId;
declare const workRef: WorkRef;
// @ts-expect-error lease and run identities are not interchangeable
const wrongRun: RunId = leaseId;
void wrongRun;
void runId;

const graphNativeAuthority: ProjectTransitionExecutionAuthority = {
  subject: 'project_transition',
  lease_id: leaseId,
  lease_ref: leaseId,
  run_id: runId,
  repository: 'laurajoyhutchins/overcenter',
  project_ref: 'github:laurajoyhutchins/overcenter',
  transition_id: 'graph-native-transition',
  authority: { kind: 'github', revision: '1111111111111111111111111111111111111111' },
  graph_fingerprint: 'graph-fingerprint',
  transition_definition_fingerprint: 'transition-fingerprint',
};
void graphNativeAuthority;

// @ts-expect-error graph-native project transition authority must not expose a legacy lane gate
graphNativeAuthority.gate;
// @ts-expect-error graph-native project transition authority must not expose a legacy Linear work identity
graphNativeAuthority.work_ref;

const legacyWorkAuthority: LegacyWorkExecutionAuthority = {
  work_ref: workRef,
  lease_id: leaseId,
  run_id: runId,
  gate: 'lane:repo-implementation',
  repository: 'laurajoyhutchins/overcenter',
  execution_fingerprint: 'legacy-work-fingerprint',
};
void legacyWorkAuthority;

const interactive: OrchestrationRunMode = RUN_MODES[1];
const completed: WorkSettlementDisposition = WORK_SETTLEMENT_DISPOSITIONS[0];
void interactive;
void completed;

// @ts-expect-error unsupported run modes cannot enter semantic logic
const background: OrchestrationRunMode = 'background';
void background;

// @ts-expect-error settlement disposition is closed
const skipped: WorkSettlementDisposition = 'skipped';
void skipped;

void RUN_FINISH_DISPOSITIONS;
void LIVE_LEASE_STATUSES;
void WORK_REQUEUE_CLASSES;

const store: ExecutionAuthorityStore = {
  async getLeaseByTokenHash() { return null; },
  async getLeaseById() { return null; },
};
void store;

declare const authority: ExecutionAuthority;
if (authority.subject === 'project_transition') {
  const transitionId: string = authority.transition_id;
  void transitionId;
  // @ts-expect-error project transitions do not expose ordinary work fingerprints
  authority.execution_fingerprint;
} else {
  const fingerprint: string | null = authority.execution_fingerprint;
  void fingerprint;
  // @ts-expect-error legacy work authority has no project transition id
  authority.transition_id;
}