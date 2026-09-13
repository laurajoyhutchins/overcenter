function fail(code,message,details=null){const error=new Error(message);error.code=code;error.details=details;throw error;}

function promotionPacket(result,suspension,transitionId){
  return Object.freeze({
    ...result,
    outcome:'AGENT_EXECUTION_REQUIRED',
    operation:'project_transition.verify_promotion',
    transition_id:transitionId,
    promotion:Object.freeze({
      schema:'project-transition-promotion-verification-v1',
      recovery_ref:suspension.recovery_ref,
      blocked_lease_ref:suspension.blocked_lease_ref,
      authority_revision:suspension.authority_revision||null,
      promotion_condition:suspension.conditions?.promotion_condition||null,
      transition_revision_fingerprint:suspension.conditions?.transition_revision_fingerprint||null,
      transition_dependency_fingerprint:suspension.conditions?.transition_dependency_fingerprint||null,
      required_result:Object.freeze({
        disposition:'completed',
        evidence:'one or more exact authoritative evidence references',
        reason:'brief judgment explaining why the recorded promotion condition is now satisfied',
      }),
    }),
  });
}

export function createProjectAdvancePromotionRuntime({host,projectTransitions}={}){
  if(!host||typeof host.advance!=='function')throw new TypeError('project.advance host is required');
  if(!projectTransitions||typeof projectTransitions.suspensionFor!=='function'||typeof projectTransitions.releaseSuspension!=='function')throw new TypeError('promotion-aware project transition service is required');
  return Object.freeze({
    async advance(input={}){
      const transitionId=typeof input?.transition_id==='string'?input.transition_id.trim():'';
      if(input?.execution_result&&input?.resume_ref&&transitionId){
        const suspension=await projectTransitions.suspensionFor({project_ref:input.project_ref,transition_id:transitionId});
        if(suspension){
          if(input.execution_result.disposition!=='completed')fail('PROJECT_TRANSITION_PROMOTION_NOT_CONFIRMED','promotion verification must report completed only when the recorded promotion condition is authoritatively satisfied',{may_have_mutated:false,recovery_ref:suspension.recovery_ref});
          const release=await projectTransitions.releaseSuspension({project_ref:input.project_ref,transition_id:transitionId,recovery_ref:suspension.recovery_ref,evidence:input.execution_result.evidence,reason:input.execution_result.reason});
          const resumed=await host.advance({project_ref:input.project_ref,transition_id:transitionId,resume_ref:input.resume_ref});
          return Object.freeze({...resumed,promotion_release:release});
        }
      }
      const result=await host.advance(input);
      if(result?.outcome==='WAITING'){
        const candidates=transitionId?[transitionId]:(Array.isArray(result.frontier)?result.frontier:[]);
        for(const candidate of candidates){
          const id=typeof candidate==='string'?candidate.trim():'';
          if(!id)continue;
          const suspension=await projectTransitions.suspensionFor({project_ref:input.project_ref,transition_id:id});
          if(suspension)return promotionPacket(result,suspension,id);
        }
      }
      return result;
    },
  });
}
