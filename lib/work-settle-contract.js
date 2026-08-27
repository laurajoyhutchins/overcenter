const OPERATING_CONDITIONS = Object.freeze(['NOMINAL','HOLD','FAULT','INDETERMINATE','OPERATOR_HOLD']);
const PRODUCTIVE_STAGES = Object.freeze(['ENABLE','ACQUIRE','EXECUTE','COMMIT','CONFIRM']);

const responsibilitySchema = Object.freeze({
  type:'object',
  required:['applicable','satisfied'],
  properties:{applicable:{type:'boolean'},satisfied:{type:'boolean'}},
  additionalProperties:false,
});

const lifecycleFactsSchema = Object.freeze({
  type:'object',
  required:['responsibilities'],
  properties:{
    condition:{type:'string',enum:OPERATING_CONDITIONS},
    responsibilities:{
      type:'object',
      required:PRODUCTIVE_STAGES,
      properties:Object.fromEntries(PRODUCTIVE_STAGES.map(stage=>[stage,responsibilitySchema])),
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
    operating_condition:{type:['string','null'],enum:[...OPERATING_CONDITIONS,null]},
    continuation:{type:['object','null']},
    lifecycle_facts:{...lifecycleFactsSchema,type:['object','null']},
  },
  additionalProperties:false,
});
