import { composeHatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { projectAdvanceFor } from 'lib/project-advance-overcenter-host.js';
import { createPostgresProjectTransitionAuthoritativeEffectConfirmationService } from 'lib/project-transition-authoritative-effect-github-runtime.js';
import { createPostgresSubjectAwareOrchestrationRunService } from 'lib/orchestration-finish-runtime.js';
import { createPostgresOrchestrationAdvanceService, createPostgresProjectTransitionLeaseService, createPostgresTargetAwareOrchestrationRunService, statusForOrchestrationAdvanceRuntimeError } from 'lib/orchestration-run-target-runtime.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor=semanticCommandDescriptor('project.advance');
function fail(code,message,details=null){const error=new Error(message);error.code=code;error.details=details;throw error;}
function promotionPacket(result,suspension){return Object.freeze({...result,outcome:'AGENT_EXECUTION_REQUIRED',operation:'project_transition.verify_promotion',promotion:Object.freeze({schema:'project-transition-promotion-verification-v1',recovery_ref:suspension.recovery_ref,blocked_lease_ref:suspension.blocked_lease_ref,authority_revision:suspension.authority_revision||null,promotion_condition:suspension.conditions?.promotion_condition||null,transition_revision_fingerprint:suspension.conditions?.transition_revision_fingerprint||null,transition_dependency_fingerprint:suspension.conditions?.transition_dependency_fingerprint||null,required_result:Object.freeze({disposition:'completed',evidence:'one or more exact authoritative evidence references',reason:'brief judgment explaining why the recorded promotion condition is now satisfied'})})});}

export const access='admin';
export default{
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args,ctx){
    const providers=composeHatchableRuntimeProviders({...(ctx?.db?{db:ctx.db}:{})});
    const{db}=providers;
    const runtime={db,api:providers.api,withGitHubAppApiClient:providers.githubAppAuth.withApiClient};
    const runs=createPostgresTargetAwareOrchestrationRunService(runtime);
    const projectTransitions=createPostgresProjectTransitionLeaseService(runtime);
    const advance=createPostgresOrchestrationAdvanceService({...runtime,projectTransitions});
    const finish=createPostgresSubjectAwareOrchestrationRunService(runtime);
    const authoritativeEffect=createPostgresProjectTransitionAuthoritativeEffectConfirmationService(runtime);
    const response=await executeCorrelatedCommand(
      'project.advance',
      args||{},
      async(input)=>{
        const host=projectAdvanceFor({db,runs,advance,finish,confirmAuthoritativeEffect:(request)=>authoritativeEffect.confirm(request)});
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
        if(result?.outcome==='WAITING'&&transitionId){
          const suspension=await projectTransitions.suspensionFor({project_ref:input.project_ref,transition_id:transitionId});
          if(suspension)return promotionPacket(result,suspension);
        }
        return result;
      },
      {statusForFailure:statusForOrchestrationAdvanceRuntimeError,defaultError:'PROJECT_ADVANCE_ERROR',defaultMessage:'project.advance failed',flattenDetails:true,db},
    );
    return response.body;
  },
};
