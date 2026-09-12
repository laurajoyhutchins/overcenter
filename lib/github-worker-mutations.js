// Runtime database and GitHub auth are injected by the composition root.
import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
import { executeGithubChangeset } from 'lib/github-changeset-execution.js';
import { applyGithubChangesetRoleAware } from 'lib/github-branch-role-runtime.js';
import { createPostgresExecutionAuthorityService } from 'lib/execution-authority.js';
import { createGithubApiAdapter } from 'lib/github-apply-changeset.js';
import { githubAppChangesetPermissionProfile } from 'lib/github-app-auth.js';
import {
  applyGithubLeaseScopedChangeset,
  resolveGithubLeaseScopedWorkspace,
} from 'lib/github-lease-scoped-changeset.js';

const ALLOWED_TEXT_FIELDS=new Set(['lease_ref','replacements','commit_message']);

function fail(code,message,details=null,httpStatus=422){
  const error=new Error(message);
  error.code=code;
  error.details=details;
  error.httpStatus=httpStatus;
  throw error;
}

const SHA40=/^[0-9a-f]{40}$/;

function hexDigest(bytes){
  return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
}

async function gitBlobSha(content){
  const body=new TextEncoder().encode(String(content));
  const header=new TextEncoder().encode('blob '+body.byteLength+'\u0000');
  const bytes=new Uint8Array(header.byteLength+body.byteLength);
  bytes.set(header,0);
  bytes.set(body,header.byteLength);
  return hexDigest(await crypto.subtle.digest('SHA-1',bytes));
}

async function responseSha(value){
  return sha256Text(canonicalJson(value));
}

function authorityEpochFor(authority,shared){
  const epoch=Number(authority?.authority_epoch ?? shared.authority_epoch ?? 0);
  if(!Number.isSafeInteger(epoch)||epoch<0) return fail('EXECUTION_AUTHORITY_INVALID','project transition authority epoch is invalid',{authority_epoch:authority?.authority_epoch ?? shared.authority_epoch ?? null},409);
  return epoch;
}

function workspaceMatches(expected,observed){
  return ['workspace_digest','branch','authority_revision','observed_head'].every(field=>expected?.[field]===observed?.[field]);
}

function changesetEffectRef(request,result){
  const head=String(result?.new_head || result?.commit_sha || '').trim().toLowerCase();
  if(!SHA40.test(head)) return null;
  return 'github-changeset:'+request.repo+'#'+request.branch+'@'+head;
}

async function changesetFacts(request,result){
  const evidence=result && typeof result==='object'?result:{result:String(result)};
  const response_sha256=await responseSha(evidence);
  const effect_ref=changesetEffectRef(request,result);
  if(result?.ok===true&&effect_ref){
    return {transport:'accepted',committed:true,effect_ref,response_sha256,evidence};
  }
  if(result?.may_have_mutated===true||result?.mutation_certainty==='may_have_mutated'){
    return {transport:'unknown',committed:null,effect_ref:null,response_sha256:null,evidence};
  }
  return {transport:'rejected',committed:false,effect_ref:null,response_sha256,evidence};
}

function unknownChangesetConfirmation(evidence){
  return {status:'unknown',effect_ref:null,predicate:'github-changeset-readback',evidence};
}

async function confirmGithubChangeset(request,workspace,shared,mode){
  let current;
  try {
    current=await shared.readBranch({repo:request.repo,branch:request.branch,changes:Array.isArray(request.changes)?request.changes:[]});
  } catch(error) {
    return unknownChangesetConfirmation({phase:'confirm.branch_read',error:String(error?.message||error)});
  }
  const currentHead=String(current?.sha || current || '').trim().toLowerCase() || null;
  const priorHead=workspace.observed_head || workspace.authority_revision;
  if(!currentHead||currentHead===priorHead){
    return {
      status:'absent',
      effect_ref:null,
      predicate:'github-changeset-head-unchanged',
      evidence:{branch:request.branch,prior_head:priorHead,current_head:currentHead},
    };
  }
  if(mode!=='changes'){
    return unknownChangesetConfirmation({
      phase:'confirm',
      reason:'text replacement effect cannot be proven from the durable request alone',
      branch:request.branch,
      prior_head:priorHead,
      current_head:currentHead,
    });
  }
  try {
    return await shared.withGithub({repo:request.repo,changes:request.changes},async(github)=>{
      const commit=await github.getCommit(request.repo,currentHead);
      const parent=String(commit?.parents?.[0]||'').toLowerCase();
      if(parent!==String(priorHead).toLowerCase()||String(commit?.message||'')!==request.commit_message){
        return unknownChangesetConfirmation({
          phase:'confirm.commit_identity',
          prior_head:priorHead,
          current_head:currentHead,
          parent,
          message:String(commit?.message||''),
        });
      }
      const changes=Array.isArray(request.changes)?request.changes:[];
      const entries=await github.getPathEntries(request.repo,commit.tree_sha,changes.map(change=>change.path));
      for(const change of changes){
        const entry=entries.get(change.path)||null;
        if(change.operation==='delete'){
          if(entry) return unknownChangesetConfirmation({phase:'confirm.tree',path:change.path,reason:'deleted path is present'});
          continue;
        }
        if(typeof change.content!=='string'||!entry||String(entry.sha||'').toLowerCase()!==await gitBlobSha(change.content)){
          return unknownChangesetConfirmation({phase:'confirm.tree',path:change.path,reason:'changed blob does not match the exact request'});
        }
      }
      return {
        status:'confirmed',
        effect_ref:'github-changeset:'+request.repo+'#'+request.branch+'@'+currentHead,
        predicate:'github-changeset-commit-and-tree-match',
        evidence:{
          branch:request.branch,
          prior_head:priorHead,
          current_head:currentHead,
          commit_sha:currentHead,
          tree_sha:commit.tree_sha,
          changed_paths:changes.map(change=>change.path).sort(),
        },
      };
    });
  } catch(error) {
    return unknownChangesetConfirmation({phase:'confirm.provider_readback',error:String(error?.message||error)});
  }
}

async function executeLeaseScopedGithubEffect(input,shared,mode){
  if(!shared.executionTransactionStore||typeof shared.executionTransactionStore.prepareExecution!=='function'){
    return fail('EXECUTION_TRANSACTION_STORE_REQUIRED','lease-scoped GitHub mutation requires the authoritative execution transaction store',null,503);
  }
  const prepared=await resolveGithubLeaseScopedWorkspace({lease_ref:input.lease_ref,changes:mode==='changes'?input.changes:input.replacements},{executionAuthority:shared.executionAuthority,readBranch:shared.readBranch});
  const authority=prepared.execution_authority;
  const workspace=prepared.workspace;
  const workspaceEvidence=authority.github_workspace;
  const epoch=authorityEpochFor(authority,shared);
  const runId=String(shared.run_id||authority.run_id||'').trim();
  if(!runId) return fail('EXECUTION_AUTHORITY_INVALID','project transition authority did not include a run identity',null,409);
  const semanticRequest={
    project_ref:authority.project_ref,
    subject_key:authority.project_ref+':transition:'+authority.transition_id+':'+(mode==='changes'?'changeset':'text-replacement'),
    repository:workspace.repository,
    authority_revision:workspace.authority_revision,
    authority_epoch:epoch,
    graph_fingerprint:String(authority.graph_fingerprint||workspace.workspace_digest),
    transition_fingerprint:authority.transition_definition_fingerprint,
    repo:workspace.repository,
    branch:workspace.branch,
    base_revision:workspace.authority_revision,
    expected_head:workspace.observed_head,
    changes:mode==='changes'?input.changes:{mode:'text_replacements',replacements:input.replacements},
    commit_message:input.commit_message,
  };
  let invokedResult=null;
  const transaction=await executeGithubChangeset(semanticRequest,{
    executionTransactionStore:shared.executionTransactionStore,
    executionContext(){
      return {
        run_id:runId,
        subject_kind:'provider_operation',
        lease_epoch:Number(shared.lease_epoch||epoch||1),
        authority_epoch:epoch,
        lease_expires_at:shared.lease_expires_at||new Date(Date.now()+60_000).toISOString(),
      };
    },
    providerFor(){
      return {
        async preflight(){
          const fresh=await resolveGithubLeaseScopedWorkspace({lease_ref:input.lease_ref,changes:mode==='changes'?input.changes:input.replacements},{executionAuthority:shared.executionAuthority,readBranch:shared.readBranch});
          const freshEvidence=fresh.execution_authority.github_workspace;
          const matches=workspaceMatches(workspaceEvidence,freshEvidence);
          return {
            provider:'github',
            observed_revision:matches?workspace.authority_revision:'workspace-mismatch:'+(freshEvidence.observed_head||'absent'),
            provider_identity:freshEvidence,
          };
        },
        async invoke(){
          if(mode==='changes'){
            invokedResult=await applyGithubLeaseScopedChangeset({
              lease_ref:input.lease_ref,
              changes:input.changes,
              commit_message:input.commit_message,
            },{
              ...shared,
              expectedWorkspace:workspaceEvidence,
              kernelManaged:true,
            });
          }else{
            invokedResult=await applyGithubLeaseScopedTextReplacements(input,{
              ...shared,
              readTextAtRef:shared.readTextAtRef,
              expectedWorkspace:workspaceEvidence,
              kernelManaged:true,
            });
          }
          return changesetFacts(semanticRequest,invokedResult);
        },
        async confirm(){
          return confirmGithubChangeset(semanticRequest,workspace,shared,mode);
        },
      };
    },
  });
  if(transaction.receipt.disposition==='completed'){
    if(invokedResult) return {...invokedResult,idempotent_replay:false,execution_id:transaction.identity.execution_id};
    const effectRef=String(transaction.receipt.effect_ref||'');
    const head=effectRef.split('@').pop()||null;
    return {
      ok:true,
      repo:semanticRequest.repo,
      branch:semanticRequest.branch,
      base_sha:semanticRequest.base_revision,
      old_head:workspace.observed_head,
      new_head:head,
      commit_sha:head,
      precondition_verified:workspace.observed_head!==null,
      idempotent_replay:true,
      execution_id:transaction.identity.execution_id,
    };
  }
  if(invokedResult) return {...invokedResult,execution_id:transaction.identity.execution_id};
  return {
    ok:false,
    error:'EXECUTION_NOT_COMPLETED',
    message:'GitHub changeset execution did not settle as completed',
    disposition:transaction.receipt.disposition,
    execution_id:transaction.identity.execution_id,
    may_have_mutated:false,
  };
}

function requiredString(value,field,max=10000){
  if(typeof value!=='string'||value.length===0||value.length>max) {
    return fail('INVALID_REQUEST',`${field} must be a bounded non-empty string`,{field});
  }
  return value;
}

function validatePath(value,index){
  const path=requiredString(value,`replacements[${index}].path`,4096);
  const segments=path.split('/');
  if(path.startsWith('/')||path.endsWith('/')||path.includes('\\')||/[\u0000-\u001f\u007f]/.test(path)||segments.some(segment=>!segment||segment==='.'||segment==='..')){
    return fail('INVALID_PATH','replacement path must be a clean repository-relative path',{path,index});
  }
  return path;
}

function validateTextReplacementRequest(input){
  if(!input||typeof input!=='object'||Array.isArray(input)) return fail('INVALID_REQUEST','request must be an object');
  const unknown=Object.keys(input).filter(key=>!ALLOWED_TEXT_FIELDS.has(key)).sort();
  if(unknown.length) return fail('INVALID_REQUEST','lease-scoped text replacements cannot include caller-selected Git coordinates',{unknown});
  const leaseRef=requiredString(input.lease_ref,'lease_ref',128).trim();
  const commitMessage=requiredString(input.commit_message,'commit_message',10000);
  if(!Array.isArray(input.replacements)||input.replacements.length<1||input.replacements.length>32){
    return fail('INVALID_REQUEST','replacements must contain 1..32 entries',{field:'replacements'});
  }
  const replacements=input.replacements.map((replacement,index)=>{
    if(!replacement||typeof replacement!=='object'||Array.isArray(replacement)) return fail('INVALID_REPLACEMENT',`invalid replacement at index ${index}`,{index});
    const unknownReplacement=Object.keys(replacement).filter(key=>!['path','old','new_text','expected_count'].includes(key)).sort();
    if(unknownReplacement.length) return fail('INVALID_REPLACEMENT',`replacement at index ${index} contains unknown fields`,{index,unknown:unknownReplacement});
    const path=validatePath(replacement.path,index);
    const oldText=requiredString(replacement.old,`replacements[${index}].old`,1_000_000);
    if(typeof replacement.new_text!=='string'||replacement.new_text.length>1_000_000) return fail('INVALID_REPLACEMENT',`replacement new_text at index ${index} is invalid`,{index});
    const expectedCount=replacement.expected_count===undefined?1:Number(replacement.expected_count);
    if(!Number.isInteger(expectedCount)||expectedCount<1) return fail('INVALID_REPLACEMENT',`replacement expected_count at index ${index} is invalid`,{index});
    return Object.freeze({path,oldText,newText:replacement.new_text,expectedCount,index});
  });
  return Object.freeze({lease_ref:leaseRef,replacements:Object.freeze(replacements),commit_message:commitMessage});
}

function occurrences(text,needle){
  let count=0;
  let offset=0;
  while(true){
    const found=text.indexOf(needle,offset);
    if(found<0)return count;
    count+=1;
    offset=found+needle.length;
  }
}

function encodePath(path){
  return String(path).split('/').map(encodeURIComponent).join('/');
}

function decodeBase64Utf8(value){
  try{
    const binary=atob(String(value||'').replace(/\s+/g,''));
    const bytes=Uint8Array.from(binary,character=>character.charCodeAt(0));
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }catch{
    return fail('SOURCE_READ_FAILED','GitHub returned non-UTF-8 text content',null,422);
  }
}

function permissionProfileForChanges(changes=[]){
  return githubAppChangesetPermissionProfile((Array.isArray(changes)?changes:[]).map(change=>change?.path));
}

function githubTransportFor(options={}){
  if(typeof options.withGitHubAppApiClient!=='function') return fail('EXECUTION_AUTHORITY_UNAVAILABLE','GitHub App auth provider is required',null,503);
  return options.withGitHubAppApiClient;
}

function defaultWithGithubFor(withGitHubAppApiClient){
  return async function defaultWithGithub({repo,changes=[]},callback){
    return withGitHubAppApiClient(repo,async(apiClient)=>callback(createGithubApiAdapter(apiClient)),{
      permissionProfile:permissionProfileForChanges(changes),
    });
  };
}

function defaultReadBranchFor(withGithub){
  return async function defaultReadBranch(request){
    return withGithub(request,(github)=>github.getBranch(request.repo,request.branch,{phase:'lease_scope.workspace_head'}));
  };
}

function defaultReadTextAtRefFor(withGitHubAppApiClient){
  return async function defaultReadTextAtRef({repo,ref,path}){
    return withGitHubAppApiClient(repo,async(apiClient)=>{
    const response=await apiClient.call('github',{
      method:'GET',
      path:`/repos/${repo.split('/').map(encodeURIComponent).join('/')}/contents/${encodePath(path)}`,
      query:{ref},
      headers:{
        Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2026-03-10',
        'User-Agent':'Overcenter/1.0',
      },
    });
    if(Number(response?.status||0)!==200||response?.body?.encoding!=='base64'){
      return fail('SOURCE_READ_FAILED',`unable to read ${path} at exact workspace revision`,{path,ref,status:response?.status||null},422);
    }
    return decodeBase64Utf8(response.body.content);
    },{permissionProfile:githubAppChangesetPermissionProfile([path])});
  };
}

export async function applyGithubLeaseScopedTextReplacements(input,options={}){
  const request=validateTextReplacementRequest(input);
  const {executionAuthority,readBranch,readTextAtRef,withGithub,applyChangeset,...applyOptions}=options;
  if(!executionAuthority||typeof executionAuthority.require!=='function') return fail('EXECUTION_AUTHORITY_UNAVAILABLE','lease-scoped text replacement requires execution authority',null,503);
  if(typeof readBranch!=='function'||typeof readTextAtRef!=='function'||typeof withGithub!=='function'||typeof applyChangeset!=='function') {
    return fail('EXECUTION_AUTHORITY_UNAVAILABLE','lease-scoped text replacement runtime is incomplete',null,503);
  }

  const permissionChanges=request.replacements.map(replacement=>({path:replacement.path,operation:'update'}));
  const prepared=await resolveGithubLeaseScopedWorkspace({lease_ref:request.lease_ref,changes:permissionChanges},{executionAuthority,readBranch});
  const workspaceEvidence=prepared.execution_authority.github_workspace;
  const readRef=workspaceEvidence.observed_head||workspaceEvidence.authority_revision;
  const byPath=new Map();
  for(const replacement of request.replacements){
    if(!byPath.has(replacement.path))byPath.set(replacement.path,[]);
    byPath.get(replacement.path).push(replacement);
  }

  const changes=[];
  for(const [path,specs] of byPath.entries()){
    let content=await readTextAtRef({repo:prepared.workspace.repository,ref:readRef,path});
    if(typeof content!=='string') return fail('SOURCE_READ_FAILED',`unable to read ${path} as UTF-8 text`,{path,ref:readRef},422);
    for(const spec of specs){
      const actualCount=occurrences(content,spec.oldText);
      if(actualCount!==spec.expectedCount){
        return fail('TEXT_PRECONDITION_FAILED',`replacement precondition failed for ${path}`,{
          path,
          replacement_index:spec.index,
          expected_count:spec.expectedCount,
          actual_count:actualCount,
        },422);
      }
      content=content.split(spec.oldText).join(spec.newText);
    }
    changes.push({path,operation:'update',content,ensure_final_newline:content.endsWith('\n')});
  }

  return applyGithubLeaseScopedChangeset({
    lease_ref:request.lease_ref,
    changes,
    commit_message:request.commit_message,
  },{
    executionAuthority,
    readBranch,
    withGithub,
    applyChangeset,
    expectedWorkspace:workspaceEvidence,
    ...applyOptions,
  });
}

export function createGithubWorkerMutationRuntime(options={}){
  const db=options.db;
  if(!db||typeof db.query!=='function') return fail('EXECUTION_AUTHORITY_UNAVAILABLE','database provider is required',null,503);
  const withGitHubAppApiClient=githubTransportFor(options);
  const defaultWithGithub=defaultWithGithubFor(withGitHubAppApiClient);
  const executionAuthority=options.executionAuthority||createPostgresExecutionAuthorityService({db,api:options.api,withGitHubAppApiClient});
  const withGithub=options.withGithub||defaultWithGithub;
  const readBranch=options.readBranch||defaultReadBranchFor(withGithub);
  const readTextAtRef=options.readTextAtRef||defaultReadTextAtRefFor(withGitHubAppApiClient);
  const applyChangeset=options.applyChangeset||applyGithubChangesetRoleAware;
  const runId=options.run_id||null;
  const executionTransactionStore=options.executionTransactionStore||null;
  const shared={
    executionAuthority,
    readBranch,
    readTextAtRef,
    withGithub,
    applyChangeset,
    db,
    run_id:runId,
    lease_epoch:options.lease_epoch,
    lease_expires_at:options.lease_expires_at,
    authority_epoch:options.authority_epoch,
    executionTransactionStore,
  };
  return Object.freeze({
    applyChangeset(request){
      return executeLeaseScopedGithubEffect(request,shared,'changes');
    },
    applyTextReplacements(request){
      return executeLeaseScopedGithubEffect(request,shared,'text');
    },
  });
}

export function statusForGithubWorkerMutationError(error){
  const status=Number(error?.httpStatus||error?.http_status||0);
  if(Number.isInteger(status)&&status>=400&&status<=599)return status;
  if(['HEAD_MISMATCH','BRANCH_CREATION_RACE','EXECUTION_AUTHORITY_STALE','LEASE_SCOPED_CHANGESET_PROJECT_TRANSITION_REQUIRED'].includes(error?.code))return 409;
  if(String(error?.code||'').startsWith('INVALID_')||['TEXT_PRECONDITION_FAILED','SOURCE_READ_FAILED'].includes(error?.code))return 422;
  if(error?.code==='EXECUTION_AUTHORITY_UNAVAILABLE')return 503;
  return null;
}
