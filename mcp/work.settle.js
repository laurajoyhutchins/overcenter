import { executeWorkSettleBoundary } from 'lib/work-settle-boundary.js';
import { WORK_SETTLE_INPUT_SCHEMA } from 'lib/work-settle-contract.js';

export const access = 'admin';
export default {
  name:'work.settle',
  description:'Truthfully consume one valid work lease as completed, requeue, or blocked. Supply the non-secret lease_ref plus settlement semantics; lease capability lookup, run correlation, deterministic retry identity, and lifecycle routing are derived internally.',
  inputSchema:WORK_SETTLE_INPUT_SCHEMA,
  async handler(args,ctx){const response=await executeWorkSettleBoundary(args||{},{db:ctx?.db});return response.body;}
};
