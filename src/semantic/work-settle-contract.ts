import {
  OPERATING_CONDITIONS,
  PRODUCTIVE_STAGES,
  WORK_REQUEUE_CLASSES,
  WORK_SETTLEMENT_DISPOSITIONS,
  type OperatingCondition,
  type ProductiveStage,
  type WorkRequeueClass,
  type WorkSettlementDisposition,
} from './execution-lifecycle-contracts.js';

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

const responsibility = Object.freeze({
  type:'object',
  required:['applicable','satisfied'],
  properties:{applicable:{type:'boolean'},satisfied:{type:'boolean'}},
  additionalProperties:false,
});

const lifecycleFacts = Object.freeze({
  type:['object','null'],
  properties:{
    condition:{type:'string',enum:[...OPERATING_CONDITIONS]},
    responsibilities:{
      type:'object',
      properties:Object.fromEntries(PRODUCTIVE_STAGES.map((stage) => [stage, responsibility])),
      additionalProperties:false,
    },
  },
  additionalProperties:false,
});

export const WORK_SETTLE_INPUT_SCHEMA = Object.freeze({
  type:'object',
  required:['lease_ref','disposition'],
  properties:{
    lease_ref:{type:'string'},
    disposition:{type:'string',enum:[...WORK_SETTLEMENT_DISPOSITIONS]},
    evidence:{type:'array',items:{type:'object',required:['kind','ref'],properties:{kind:{type:'string'},ref:{type:'string'}},additionalProperties:false}},
    reason:{type:['string','null']},
    promotion_condition:{type:['string','null']},
    requeue_class:{type:['string','null'],enum:[...WORK_REQUEUE_CLASSES,null]},
    operating_condition:{type:['string','null'],enum:[...OPERATING_CONDITIONS,null]},
    continuation:{type:['object','null']},
    lifecycle_facts:lifecycleFacts,
  },
  additionalProperties:false,
});

export const WORK_SETTLE_SEMANTIC_FIELDS = Object.freeze(Object.keys(WORK_SETTLE_INPUT_SCHEMA.properties));
export const WORK_SETTLE_REQUIRED_FIELDS = Object.freeze([...WORK_SETTLE_INPUT_SCHEMA.required]);
