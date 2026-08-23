import { createPostgresScheduledExecutionContextService } from 'lib/scheduled-execution-context.js';

export const access = 'admin';

export default {
  name:'scheduled_execution',
  description:'Execute one semantic scheduled-worker operation through the runtime-owned scheduled context. The caller supplies participant plus claim/progress/settle/idle semantics, or Dispatcher reconciliation; run, cycle, lease, heartbeat, deterministic maintenance, terminalization, and transport correlation stay runtime-owned.',
  inputSchema:{
    type:'object',
    required:['participant','operation'],
    additionalProperties:false,
    properties:{
      participant:{
        type:'string',
        enum:['portfolio-dispatcher','repository-implementation','source-data-implementation','exact-head-verification','portfolio-integration'],
      },
      operation:{type:'string',enum:['claim','progress','settle','reconcile','idle']},
      input:{type:'object'},
    },
  },
  async handler(args,ctx){
    return createPostgresScheduledExecutionContextService({db:ctx?.db}).execute(args || {});
  },
};
