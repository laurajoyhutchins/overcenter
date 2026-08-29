import type { LeaseId, RunId } from '../src/semantic/semantic-identities.js';
import {
  EXECUTION_GATES,
  type ExecutionAuthority,
  type ExecutionAuthorityLocator,
  type ExecutionAuthorityStore,
  type ExecutionGate,
} from '../src/semantic/execution-authority-contracts.js';
import {
  LIVE_LEASE_STATUSES,
  RUN_FINISH_DISPOSITIONS,
  RUN_MODES,
  WORK_REQUEUE_CLASSES,
  WORK_SETTLEMENT_DISPOSITIONS,
  type OrchestrationRunMode,
  type WorkSettlementDisposition,
} from '../src/semantic/execution-lifecycle-contracts.js';

const implementationGate: ExecutionGate = 'lane:repo-implementation';
const verificationGate: ExecutionGate = EXECUTION_GATES[4];
void implementationGate;
void verificationGate;

// @ts-expect-error execution gates are a closed vocabulary
const impossibleGate: ExecutionGate = 'lane:imaginary';
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
// @ts-expect-error lease and run identities are not interchangeable
const wrongRun: RunId = leaseId;
void wrongRun;
void runId;

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
  async getSlot() { return null; },
  async getRun() { return null; },
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
  // @ts-expect-error ordinary work authority has no project transition id
  authority.transition_id;
}
