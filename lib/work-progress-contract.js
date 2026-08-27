const evidence = { type:'array', maxItems:50, items:{ type:'object', required:['kind','ref'], properties:{kind:{type:'string'},ref:{type:'string'}}, additionalProperties:false } };
const revisions = { type:'array', maxItems:25, items:{ type:'object', required:['kind','ref','revision'], properties:{kind:{type:'string'},ref:{type:'string'},revision:{type:'string'}}, additionalProperties:false } };

export const WORK_CHECKPOINT_REQUIRED_FIELDS = Object.freeze(['lease_ref','phase','next_action']);
export const WORK_CHECKPOINT_SEMANTIC_FIELDS = Object.freeze(['lease_ref','phase','next_action','candidate','completed','evidence','authority_revisions']);
export const WORK_HEARTBEAT_REQUIRED_FIELDS = Object.freeze(['lease_ref']);
export const WORK_HEARTBEAT_SEMANTIC_FIELDS = Object.freeze(['lease_ref','extend_seconds','phase','next_action','candidate','completed','evidence','authority_revisions']);

export const WORK_CHECKPOINT_INPUT_SCHEMA = Object.freeze({
  type:'object',
  required:[...WORK_CHECKPOINT_REQUIRED_FIELDS],
  properties:{
    lease_ref:{type:'string'},
    phase:{type:'string'},
    next_action:{type:'string',minLength:1,maxLength:128},
    candidate:{type:['object','null']},
    completed:evidence,
    evidence,
    authority_revisions:revisions,
  },
  additionalProperties:false,
});

export const WORK_HEARTBEAT_INPUT_SCHEMA = Object.freeze({
  type:'object',
  required:[...WORK_HEARTBEAT_REQUIRED_FIELDS],
  properties:{
    lease_ref:{type:'string'},
    extend_seconds:{type:'integer',minimum:60,maximum:3600},
    phase:{type:'string'},
    next_action:{type:'string',minLength:1,maxLength:128},
    candidate:{type:['object','null']},
    completed:evidence,
    evidence,
    authority_revisions:revisions,
  },
  additionalProperties:false,
});