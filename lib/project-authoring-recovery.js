import { canonicalJson, sha256Text } from './canonical-json.js';
import { createCompactProviderOperationPostgresStore } from './compact-provider-operation-store.js';
import { projectAuthoringIdempotencyKey, projectDefinitionIdempotencyKey } from './project-authoring-github-runtime.js';

const COMMANDS=new Set(['project.define','project.amend']);
const WAITING='WAITING_EXTERNAL_VERIFICATION';
const RECOMPUTE='RECOMPUTE_REQUIRED';
const BLOCKED='RECOVERY_BLOCKED';

function fail(code,message,details=null,mayHaveMutated=false){const error=new Error(message);error.code=code;error.may_have_mutated=Boolean(mayHaveMutated);error.details=details;return error;}
function object(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function phase(operation){return String(object(operation?.recovery_payload).phase||'');}
function attempt(operation){return String(object(operation?.recovery_payload).attempt_token||'');}
function boundedLimit(value){return Math.min(100,Math.max(1,Number(value)||20));}
function exactCommand(command){const normalized=String(command||'').trim();if(!COMMANDS.has(normalized))throw fail('PROJECT_AUTHORING_RECOVERY_REQUEST_INVALID','project authoring recovery command must be project.define or project.amend');return normalized;}
async function idempotencyKey(command,input){return command==='project.define'?projectDefinitionIdempotencyKey(input):projectAuthoringIdempotencyKey(input);}
async function operationIdentity(commandInput,input){const command=exactCommand(commandInput);const projectRef=String(input?.project_ref||'').trim();if(!projectRef)throw fail('PROJECT_AUTHORING_RECOVERY_REQUEST_INVALID','project_ref is required');const key=await idempotencyKey(command,input);const requestSha=await sha256Text(canonicalJson({command,input}));return Object.freeze({command,scope:`project:${projectRef}`,idempotency_key:key,request_sha256:requestSha,project_ref:projectRef,expected_revision:String(input?.expected_revision||'').trim().toLowerCase()});}
function waitingPredicates(error){const integration=object(error?.details?.integration);const verification=object(integration.verification);return Object.freeze({verification:String(verification.state||integration.outcome||'pending')});}
function lastReconciliation(error,observedAt){const integration=object(error?.details?.integration);return Object.freeze({observed_at:observedAt,code:String(error?.code||'PROJECT_AUTHORING_INTEGRATION_PENDING'),outcome:String(integration.outcome||'waiting'),verification:object(integration.verification)});}
function recoveryPayload(identity,input,error,observedAt,targetPhase=WAITING){const details=object(error?.details);const integration=object(details.integration);return Object.freeze({phase:targetPhase,command:identity.command,request:input,request_sha256:identity.request_sha256,idempotency_key:identity.idempotency_key,project_ref:identity.project_ref,expected_revision:identity.expected_revision,repository:details.repository||null,base:details.base||null,head:details.head||null,staged_revision:details.staged_revision||integration.expected_head||null,pull_request:integration.pull_request||details.pull_request||null,waiting_predicates:targetPhase===WAITING?waitingPredicates(error):null,last_reconciliation:lastReconciliation(error,observedAt),last_error:{code:String(error?.code||'PROJECT_AUTHORING_RECOVERY_ERROR'),message:String(error?.message||'project authoring recovery failed'),details}});}
function errorFromOperation(operation){const recovery=object(operation?.recovery_payload);if(operation?.state==='succeeded'&&object(operation?.resolution).result)return object(operation.resolution).result;if(operation?.state==='indeterminate')throw fail('PROJECT_AUTHORING_RECOVERY_INDETERMINATE','project authoring transaction has an unresolved external effect',{operation_id:operation.operation_id||null,idempotency_key:operation.idempotency_key||null,recovery},true);if(recovery.phase===WAITING)throw fail('PROJECT_AUTHORING_INTEGRATION_PENDING','project authoring candidate is staged and awaiting authoritative GitHub integration',{...recovery,operation_state:WAITING},true);if(recovery.phase===RECOMPUTE)throw fail('PROJECT_AUTHORING_INTEGRATION_RECOMPUTE_REQUIRED','project authoring authority changed while a staged candidate was waiting',{...recovery,operation_state:RECOMPUTE},true);if(recovery.phase===BLOCKED)throw fail(String(recovery.last_error?.code||'PROJECT_AUTHORING_INTEGRATION_FAILED'),String(recovery.last_error?.message||'project authoring recovery is blocked'),{...recovery,operation_state:BLOCKED},true);throw fail('IDEMPOTENCY_IN_PROGRESS','project authoring operation is already executing',{idempotency_key:operation?.idempotency_key||null},Boolean(operation?.may_have_mutated));}
function isRecompute(error){return ['PROJECT_AUTHORING_AUTHORITY_STALE','PROJECT_AUTHORING_INTEGRATION_RECOMPUTE_REQUIRED'].includes(String(error?.code||''));}
function deterministicPostStagingFailure(error){const code=String(error?.code||'');if(code.startsWith('PROJECT_AUTHORING_CANDIDATE_'))return true;if(code==='PROJECT_AUTHORING_INTEGRATION_FAILED')return true;const integration=object(error?.details?.integration);return Object.keys(integration).length>0&&integration.may_have_mutated!==true&&integration.error!=='GITHUB_INTEGRATION_INDETERMINATE';}
function outcomeFor(error){return String(error?.authoring_recovery_outcome||'failed');}

export function createProjectAuthoringRecoveryService(options={}){
  const operations=options.operations;if(!operations)throw new TypeError('operations is required');
  const listPending=typeof options.listPending==='function'?options.listPending:async()=>[];
  const executeAuthoring=typeof options.executeAuthoring==='function'?options.executeAuthoring:null;if(!executeAuthoring)throw new TypeError('executeAuthoring is required');
  const now=options.now||(()=>new Date().toISOString());const newAttemptToken=options.newAttemptToken||(()=>crypto.randomUUID());

  async function persistFailure(identity,input,attemptToken,error,priorMayHaveMutated){
    const observedAt=now();
    if(String(error?.code||'')==='PROJECT_AUTHORING_INTEGRATION_PENDING'){
      await operations.pausePrepared({command:identity.command,scope:identity.scope,idempotency_key:identity.idempotency_key,attempt_token:attemptToken,updated_at:observedAt,may_have_mutated:true,recovery_payload:recoveryPayload(identity,input,error,observedAt,WAITING)});
      error.authoring_recovery_outcome='waiting';return;
    }
    if(priorMayHaveMutated&&isRecompute(error)){
      await operations.pausePrepared({command:identity.command,scope:identity.scope,idempotency_key:identity.idempotency_key,attempt_token:attemptToken,updated_at:observedAt,may_have_mutated:true,recovery_payload:recoveryPayload(identity,input,error,observedAt,RECOMPUTE)});
      error.authoring_recovery_outcome='recompute_required';return;
    }
    if((priorMayHaveMutated||error?.may_have_mutated===true)&&deterministicPostStagingFailure(error)){
      await operations.pausePrepared({command:identity.command,scope:identity.scope,idempotency_key:identity.idempotency_key,attempt_token:attemptToken,updated_at:observedAt,may_have_mutated:true,recovery_payload:recoveryPayload(identity,input,error,observedAt,BLOCKED)});
      error.authoring_recovery_outcome='blocked';return;
    }
    if(priorMayHaveMutated||error?.may_have_mutated===true){
      await operations.markIndeterminate({command:identity.command,scope:identity.scope,idempotency_key:identity.idempotency_key,attempt_token:attemptToken,updated_at:observedAt,recovery_payload:recoveryPayload(identity,input,error,observedAt,'INDETERMINATE_EXTERNAL_EFFECT')});
      error.authoring_recovery_outcome='indeterminate';return;
    }
    if(typeof operations.abandon==='function')await operations.abandon({command:identity.command,scope:identity.scope,idempotency_key:identity.idempotency_key,attempt_token:attemptToken});
    error.authoring_recovery_outcome='failed';
  }

  async function executeOwned(identity,input,attemptToken,priorMayHaveMutated=false){
    try{
      const result=await executeAuthoring(identity.command,input);
      const digest=await sha256Text(canonicalJson(result));
      const revision=String(result?.authority?.revision||'').trim().toLowerCase();
      const settled=await operations.succeed({command:identity.command,scope:identity.scope,idempotency_key:identity.idempotency_key,attempt_token:attemptToken,updated_at:now(),may_have_mutated:true,effect_kind:'project_authority_revision',effect_ref:revision?`${identity.project_ref}@${revision}`:identity.project_ref,effect_sha256:digest,result_sha256:digest,resolution:{result}});
      if(!settled)throw fail('PROJECT_AUTHORING_RECOVERY_OWNERSHIP_LOST','project authoring recovery lost operation ownership before terminal settlement',{idempotency_key:identity.idempotency_key},true);
      return result;
    }catch(error){
      if(String(error?.code||'')==='PROJECT_AUTHORING_RECOVERY_OWNERSHIP_LOST')throw error;
      await persistFailure(identity,input,attemptToken,error,priorMayHaveMutated);
      throw error;
    }
  }

  async function execute(commandInput,input={}){
    const identity=await operationIdentity(commandInput,input);
    const existing=await operations.get(identity.command,identity.scope,identity.idempotency_key);
    if(existing)return errorFromOperation(existing);
    const attemptToken=newAttemptToken();const observedAt=now();
    const claim=await operations.claim({command:identity.command,scope:identity.scope,idempotency_key:identity.idempotency_key,request_sha256:identity.request_sha256,attempt_token:attemptToken,created_at:observedAt,stale_before:observedAt,recovery_payload:{phase:'EXECUTING',command:identity.command,request:input,request_sha256:identity.request_sha256,idempotency_key:identity.idempotency_key,project_ref:identity.project_ref,expected_revision:identity.expected_revision}});
    if(claim?.outcome==='claimed')return executeOwned(identity,input,attemptToken,false);
    if(claim?.outcome==='conflict')throw fail('IDEMPOTENCY_CONFLICT','project authoring idempotency key was reused for a different request',{idempotency_key:identity.idempotency_key});
    return errorFromOperation(claim?.operation);
  }

  async function reconcile(operation){
    const recovery=object(operation?.recovery_payload);if(operation?.state!=='prepared'||recovery.phase!==WAITING)return {kind:'project_authoring_reconciliation',outcome:'not_waiting',idempotency_key:operation?.idempotency_key||null};
    const input=object(recovery.request);const identity=await operationIdentity(operation.command,input);
    if(identity.idempotency_key!==operation.idempotency_key||identity.request_sha256!==operation.request_sha256)throw fail('PROJECT_AUTHORING_RECOVERY_IDENTITY_MISMATCH','durable project authoring recovery identity does not match its semantic request',{operation_id:operation.operation_id||null},true);
    const attemptToken=newAttemptToken();const observedAt=now();
    const resumed=await operations.resumePrepared({command:identity.command,scope:identity.scope,idempotency_key:identity.idempotency_key,request_sha256:identity.request_sha256,prior_attempt_token:attempt(operation),attempt_token:attemptToken,updated_at:observedAt,recovery_payload:{...recovery,phase:'RECONCILING',last_reconciliation:{...object(recovery.last_reconciliation),resumed_at:observedAt}}});
    if(!resumed)return {kind:'project_authoring_reconciliation',command:identity.command,project_ref:identity.project_ref,idempotency_key:identity.idempotency_key,outcome:'already_claimed'};
    try{await executeOwned(identity,input,attemptToken,true);return {kind:'project_authoring_reconciliation',command:identity.command,project_ref:identity.project_ref,idempotency_key:identity.idempotency_key,outcome:'succeeded'};}
    catch(error){return {kind:'project_authoring_reconciliation',command:identity.command,project_ref:identity.project_ref,idempotency_key:identity.idempotency_key,outcome:outcomeFor(error),error:String(error?.code||error?.message||'failed')};}
  }

  async function maintain(limit=20){const rows=await listPending(boundedLimit(limit));const actions=[];for(const operation of rows.slice(0,boundedLimit(limit)))actions.push(await reconcile(operation));return actions;}
  async function wake(operation){return reconcile(operation);}
  return Object.freeze({execute,maintain,wake,reconcile});
}

export function createPostgresProjectAuthoringRecoveryService(options={}){
  const db=options.db;if(!db||typeof db.query!=='function')throw new TypeError('db is required');
  const operations=options.operations||createCompactProviderOperationPostgresStore(db);
  const listPending=options.listPending||async(limit)=>{const result=await db.query(`SELECT * FROM operation_state WHERE command IN ('project.define','project.amend') AND state='prepared' AND recovery_payload->>'phase'=$1 ORDER BY updated_at ASC LIMIT $2`,[WAITING,boundedLimit(limit)]);return result?.rows||[];};
  return createProjectAuthoringRecoveryService({...options,operations,listPending});
}

export const projectAuthoringRecoveryInternals=Object.freeze({waitingPhase:WAITING,recomputePhase:RECOMPUTE,blockedPhase:BLOCKED});