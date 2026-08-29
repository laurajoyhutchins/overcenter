import { db } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createHatchableCompatibilityTransitionConfirmationRuntime } from 'lib/compatibility-transition-confirmation-hatchable.js';
import { statusForCompatibilityTransitionConfirmationError } from 'lib/compatibility-transition-confirmation.js';

export const access='admin';
export const methods=['POST'];

export default async function(req,res) {
  const response=await executeCorrelatedCommand('orchestration.compatibility_confirm_transition',req.body||{},(input)=>createHatchableCompatibilityTransitionConfirmationRuntime({db}).confirm(input),{statusForFailure:statusForCompatibilityTransitionConfirmationError,defaultError:'COMPATIBILITY_TRANSITION_CONFIRMATION_ERROR',defaultMessage:'orchestration.compatibility_confirm_transition failed',flattenDetails:true,db});
  return res.status(response.status).json(response.body);
}