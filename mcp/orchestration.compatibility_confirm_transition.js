import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createCompatibilityTransitionConfirmationRuntime } from 'lib/compatibility-transition-confirmation-runtime.js';
import { statusForCompatibilityTransitionConfirmationError } from 'lib/compatibility-transition-confirmation.js';

export const access='admin';

export default {
  name:'orchestration.compatibility_confirm_transition',
  description:'Temporary cutover bridge: after orchestration.advance returns a project-transition lease, use one explicitly bound legacy compatibility work receipt to confirm that exact transition. Supply only run_id, compatibility work_ref, and the non-secret lease_ref returned by orchestration.advance. Overcenter validates durable CONFIRM-to-DONE work evidence, exact binding, transition fingerprint, lease scope, normal settlement, and authoritative DONE readback. Caller-supplied transition identity is rejected.',
  inputSchema:{type:'object',required:['run_id','work_ref','lease_ref'],properties:{run_id:{type:'string',minLength:1,maxLength:512},work_ref:{type:'string',minLength:1,maxLength:128},lease_ref:{type:'string',minLength:1,maxLength:128}},additionalProperties:false},
  async handler(args,ctx) {
    const response=await executeCorrelatedCommand('orchestration.compatibility_confirm_transition',args||{},(input)=>createCompatibilityTransitionConfirmationRuntime({db:ctx?.db}).confirm(input),{statusForFailure:statusForCompatibilityTransitionConfirmationError,defaultError:'COMPATIBILITY_TRANSITION_CONFIRMATION_ERROR',defaultMessage:'orchestration.compatibility_confirm_transition failed',flattenDetails:true,db:ctx?.db});
    return response.body;
  },
};