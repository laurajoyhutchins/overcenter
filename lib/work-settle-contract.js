const responsibility = Object.freeze({
  type:'object',
  required:['applicable','satisfied'],
  properties:{applicable:{type:'boolean'},satisfied:{type:'boolean'}},
  additionalProperties:false,
});

const lifecycleFacts = Object.freeze({
  type:['object','null'],
  properties:{
    condition:{type:'string',enum:['NOMINAL','HOLD','FAULT','INDETERMINATE','OPERATOR_HOLD']},
    responsibilities:{
      type:'object',
      properties:{ENABLE:responsibility,ACQUIRE:responsibility,EXECUTE:responsibility,COMMIT:responsibility,CONFIRM:responsibility},
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
    disposition:{type:'string',enum:['completed','requeue','blocked']},
    evidence:{type:'array',items:{type:'object',required:['kind','ref'],properties:{kind:{type:'string'},ref:{type:'string'}},additionalProperties:false}},
    reason:{type:['string','null']},
    promotion_condition:{type:['string','null']},
    requeue_class:{type:['string','null'],enum:['resume_progress','retry_runtime_failure','wait_for_observable_change','stale_candidate','insufficient_execution_window',null]},
    operating_condition:{type:['string','null'],enum:['NOMINAL','HOLD','FAULT','INDETERMINATE','OPERATOR_HOLD',null]},
    continuation:{type:['object','null']},
    lifecycle_facts:lifecycleFacts,
  },
  additionalProperties:false,
});

export const WORK_SETTLE_SEMANTIC_FIELDS = Object.freeze(Object.keys(WORK_SETTLE_INPUT_SCHEMA.properties));
export const WORK_SETTLE_REQUIRED_FIELDS = Object.freeze([...WORK_SETTLE_INPUT_SCHEMA.required]);
