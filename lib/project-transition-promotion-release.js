import { canonicalJson, sha256Text } from './canonical-json.js';
import { createProjectTransitionLeaseService } from './project-transition-leases.js';

const COMMAND='project_transition.promotion_release';
const IDEMPOTENCY_KEY='release-v1';
const RELEASE_BASES=Object.freeze(['promotion_condition_satisfied','promotion_condition_invalidated']);

function fail(code,message,details=null){const error=new Error(message);error.code=code;error.details=details;throw error;}
function text(value,field,max=1024){const normalized=typeof value==='string'?value.trim():'';if(!normalized||normalized.length>max)fail('PROJECT_TRANSITION_SUSPENSION_RELEASE_INVALID',`${field} is invalid`,{field});return normalized;}
function evidence(value){if(!Array.isArray(value)||value.length<1||value.length>50)fail('PROJECT_TRANSITION_SUSPENSION_RELEASE_INVALID','evidence must contain 1 to 50 exact references',{field:'evidence'});return value.map((item,index)=>Object.freeze({kind:text(item?.kind,`evidence[${index}].kind`,128),ref:text(item?.ref,`evidence[${index}].ref`,2048)}));}
function releaseBasis(value){const basis=value==null?'promotion_condition_satisfied':text(value,'basis',128);if(!RELEASE_BASES.includes(basis))fail('PROJECT_TRANSITION_SUSPENSION_RELEASE_INVALID','basis is invalid',{field:'basis',basis});return basis;}
function authorityRevision(graph){const revision=String(graph?.authority?.definition?.revision||'').trim().toLowerCase();if(!/^[0-9a-f]{40}$/.test(revision))fail('PROJECT_TRANSITION_AUTHORITY_INVALID','promotion release requires exact GitHub project authority');return revision;}
function scopeFor(recoveryRef){return text(recoveryRef,'recovery_ref',256);}
function resolutionMatches(operation,suspension){const release=operation?.resolution?.release;if(operation?.state!=='succeeded'||!release)return false;return release.recovery_ref===suspension.recovery_ref&&release.blocked_lease_ref===suspension.blocked_lease_ref&&release.transition_revision_fingerprint===suspension.conditions?.transition_revision_fingerprint&&release.transition_dependency_fingerprint===suspension.conditions?.transition_dependency_fingerprint&&RELEASE_BASES.includes(release.basis||'promotion_condition_satisfied');}

export function createPromotionAwareProjectTransitionLeaseService({store,operationStore,readProjectGraph,now=()=>new Date().toISOString(),uuid=()=>crypto.randomUUID()}={}){
  if(!operationStore||typeof operationStore.get!=='function'||typeof operationStore.claim!=='function'||typeof operationStore.succeed!=='function')throw new TypeError('promotion release operation store is incomplete');
  if(typeof readProjectGraph!=='function')throw new TypeError('readProjectGraph is required');
  const base=createProjectTransitionLeaseService({store,readProjectGraph,now,uuid});

  async function rawSuspension(input){return base.suspensionFor(input);}
  async function releaseOperation(suspension){return operationStore.get(COMMAND,scopeFor(suspension.recovery_ref),IDEMPOTENCY_KEY);}
  async function suspensionFor(input={}){
    const suspension=await rawSuspension(input);if(!suspension)return null;
    return resolutionMatches(await releaseOperation(suspension),suspension)?null:suspension;
  }
  async function isSuspended(input={}){return Boolean(await suspensionFor(input));}

  async function releaseSuspension(input={}){
    const projectRef=text(input.project_ref,'project_ref',512);const transitionId=text(input.transition_id,'transition_id',256);const recoveryRef=text(input.recovery_ref,'recovery_ref',256);const proof=Object.freeze(evidence(input.evidence));const basis=releaseBasis(input.basis);
    const suspension=await rawSuspension({project_ref:projectRef,transition_id:transitionId});
    if(!suspension||suspension.recovery_ref!==recoveryRef)fail('PROJECT_TRANSITION_SUSPENSION_STALE','promotion release no longer names the current blocked settlement',{project_ref:projectRef,transition_id:transitionId,recovery_ref:recoveryRef,current_recovery_ref:suspension?.recovery_ref||null});
    const graph=await readProjectGraph(Object.freeze({project_ref:projectRef}));
    const release=Object.freeze({
      schema:'project-transition-suspension-release-v1',project_ref:projectRef,transition_id:transitionId,recovery_ref:recoveryRef,blocked_lease_ref:suspension.blocked_lease_ref,
      blocked_authority_revision:suspension.authority_revision||null,authority_revision:authorityRevision(graph),transition_revision_fingerprint:suspension.conditions.transition_revision_fingerprint,transition_dependency_fingerprint:suspension.conditions.transition_dependency_fingerprint,
      promotion_condition:suspension.conditions.promotion_condition,basis,evidence:proof,reason:input.reason==null?null:text(input.reason,'reason',2000),
    });
    const requestSha=await sha256Text(canonicalJson(release));const observedAt=now();const staleBefore=new Date(Date.parse(observedAt)-300000).toISOString();const attemptToken=uuid();
    const claim=await operationStore.claim({command:COMMAND,scope:scopeFor(recoveryRef),idempotency_key:IDEMPOTENCY_KEY,request_sha256:requestSha,attempt_token:attemptToken,subject_key:`project_transition:${projectRef}:${transitionId}`,authority_revision:release.authority_revision,recovery_payload:{schema:'project-transition-suspension-release-recovery-v1',release},created_at:observedAt,stale_before:staleBefore});
    if(claim.outcome==='conflict')fail('PROJECT_TRANSITION_IDEMPOTENCY_CONFLICT','blocked settlement promotion was already released with different evidence',{recovery_ref:recoveryRef});
    if(claim.outcome==='terminal'){
      if(!resolutionMatches(claim.operation,suspension)||claim.operation.request_sha256!==requestSha)fail('PROJECT_TRANSITION_IDEMPOTENCY_CONFLICT','blocked settlement promotion terminal record conflicts with requested evidence',{recovery_ref:recoveryRef});
      return Object.freeze({ok:true,schema:'project-transition-suspension-release-v1',released:true,recovery_ref:recoveryRef,authority_revision:release.authority_revision,basis,evidence:proof,idempotent_replay:true});
    }
    if(claim.outcome!=='claimed')fail('PROJECT_TRANSITION_SUSPENSION_RELEASE_IN_PROGRESS','blocked settlement promotion release already has unresolved durable state',{recovery_ref:recoveryRef,outcome:claim.outcome});
    const resultSha=await sha256Text(canonicalJson({released:true,release}));
    const saved=await operationStore.succeed({command:COMMAND,scope:scopeFor(recoveryRef),idempotency_key:IDEMPOTENCY_KEY,attempt_token:attemptToken,may_have_mutated:true,effect_kind:'project_transition_suspension_release',effect_ref:recoveryRef,result_sha256:resultSha,resolution:{released:true,release},updated_at:observedAt});
    if(!saved||saved.state!=='succeeded'||!resolutionMatches(saved,suspension))fail('PROJECT_TRANSITION_SUSPENSION_RELEASE_INDETERMINATE','durable promotion release could not be confirmed',{recovery_ref:recoveryRef,may_have_mutated:true});
    return Object.freeze({ok:true,schema:'project-transition-suspension-release-v1',released:true,recovery_ref:recoveryRef,authority_revision:release.authority_revision,basis,evidence:proof,idempotent_replay:false});
  }

  return Object.freeze({...base,suspensionFor,isSuspended,releaseSuspension});
}
