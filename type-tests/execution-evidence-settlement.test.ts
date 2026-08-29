import {
  OPERATING_CONDITIONS,
  PRODUCTIVE_STAGES,
  type OperatingCondition,
  type ProductiveStage,
} from '../src/semantic/execution-lifecycle-contracts.js';
import {
  MUTATION_CERTAINTIES,
  type ExecutionEvidence,
  type MutationCertainty,
  type SettlementEvidence,
} from '../src/semantic/execution-evidence-contracts.js';
import {
  WORK_SETTLE_INPUT_SCHEMA,
  type WorkSettleInput,
} from '../src/semantic/work-settle-contract.js';

const execute: ProductiveStage = PRODUCTIVE_STAGES[2];
const nominal: OperatingCondition = OPERATING_CONDITIONS[0];
void execute;
void nominal;

// @ts-expect-error lifecycle stages are a closed vocabulary
const imaginaryStage: ProductiveStage = 'DEPLOY';
void imaginaryStage;

// @ts-expect-error operating conditions are a closed vocabulary
const imaginaryCondition: OperatingCondition = 'DEGRADED';
void imaginaryCondition;

const certain: MutationCertainty = MUTATION_CERTAINTIES[1];
void certain;

// @ts-expect-error mutation certainty cannot encode confidence guesses
const probable: MutationCertainty = 'probably_present';
void probable;

const completed: WorkSettleInput = {
  lease_ref: '11111111-1111-4111-8111-111111111111',
  disposition: 'completed',
  evidence: [{ kind: 'github_revision', ref: 'deadbeef' }],
  operating_condition: 'NOMINAL',
};
void completed;

const requeue: WorkSettleInput = {
  lease_ref: '11111111-1111-4111-8111-111111111111',
  disposition: 'requeue',
  requeue_class: 'resume_progress',
};
void requeue;

// @ts-expect-error settlement dispositions are closed
const skipped: WorkSettleInput = { lease_ref: 'ref', disposition: 'skipped' };
void skipped;

const settlement: SettlementEvidence = {
  lease_id: 'lease-1',
  source_ref: 'lease:lease-1:settlement',
  work_ref: 'LJH-1',
  gate: 'lane:verification',
  settlement_disposition: 'completed',
  settled_at: '2026-08-29T00:00:00Z',
  evidence_refs: [{ kind: 'github_revision', ref: 'abc' }],
  authority_after: {
    state: 'Done',
    lane: 'lane:verification',
    revision: 'revision-1',
    execution_fingerprint: 'fingerprint-1',
  },
  execution_precondition_verified: true,
};
void settlement;

declare const evidence: ExecutionEvidence;
const schema: 'execution-evidence-v1' = evidence.schema;
const certainty: MutationCertainty | undefined = evidence.commands[0]?.effect.mutation_certainty;
void schema;
void certainty;

// Runtime JSON Schema remains an exported artifact for MCP admission.
void WORK_SETTLE_INPUT_SCHEMA;
