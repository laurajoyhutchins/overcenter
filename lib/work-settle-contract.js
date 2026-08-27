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
    continuation:{type:['object','null']},
    next_state:{type:['string','null']},
    next_lane:{type:['string','null']},
  },
  additionalProperties:false,
});
