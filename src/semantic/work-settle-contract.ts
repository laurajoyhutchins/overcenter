import type {
  OperatingCondition,
  ProductiveStage,
  WorkRequeueClass,
  WorkSettlementDisposition,
} from './execution-lifecycle-contracts.js';
import { semanticCommandDescriptor } from './semantic-command-descriptors.js';

export interface WorkSettleEvidenceRef {
  readonly kind: string;
  readonly ref: string;
}

export interface WorkLifecycleResponsibility {
  readonly applicable: boolean;
  readonly satisfied: boolean;
}

export type WorkLifecycleResponsibilities = Partial<Record<ProductiveStage, WorkLifecycleResponsibility>>;

export interface WorkLifecycleFacts {
  readonly condition?: OperatingCondition;
  readonly responsibilities?: WorkLifecycleResponsibilities;
}

export interface WorkSettleInput {
  readonly lease_ref: string;
  readonly disposition: WorkSettlementDisposition;
  readonly evidence?: readonly WorkSettleEvidenceRef[];
  readonly reason?: string | null;
  readonly promotion_condition?: string | null;
  readonly requeue_class?: WorkRequeueClass | null;
  readonly operating_condition?: OperatingCondition | null;
  readonly continuation?: Readonly<Record<string, unknown>> | null;
  readonly lifecycle_facts?: WorkLifecycleFacts | null;
}

const descriptor = semanticCommandDescriptor('work.settle');

export const WORK_SETTLE_INPUT_SCHEMA = descriptor.input_schema;
export const WORK_SETTLE_SEMANTIC_FIELDS = descriptor.semantic_fields;
export const WORK_SETTLE_REQUIRED_FIELDS = descriptor.required_fields;
