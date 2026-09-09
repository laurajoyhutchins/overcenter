// Runtime database and GitHub auth are injected by the composition root.
import { applyGithubChangesetRoleAware } from 'lib/github-branch-role-runtime.js';
import { createPostgresExecutionAuthorityService } from 'lib/execution-authority.js';
import { coalesceGithubMechanicalChangeset, createGithubApiAdapter } from 'lib/github-apply-changeset.js';
import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
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

function parseStoredJson(value){
  if(value===null||value===undefined||typeof value==='object') return value;
  try{return JSON.parse(value);}catch{return null;}
}

export async function coalesceGithubLeaseScopedChangeset(input,options={}){
  if(!input||typeof input!=='object'||Array.isArray(input)) return fail('INVALID_REQUEST','request must be an object');
  const unknown=Object.keys(input).filter(key=>!['lease_ref','changes','commit_message'].includes(key)).sort();
  if(unknown.length) return fail('INVALID_REQUEST','lease-scoped coalescing cannot include caller-selected Git coordinates',{unknown});
  const leaseRef=requiredString(input.lease_ref,'lease_ref',128).trim();
  const commitMessage=requiredString(input.commit_message,'commit_message',10000);
  if(!Array.isArray(input.changes)||input.changes.length===0) return fail('INVALID_REQUEST','changes must be a non-empty array',{field:'changes'});
  const {executionAuthority,readBranch,withGithub,db}=options;
  if(!executionAuthority||typeof executionAuthority.require!=='function'||typeof readBranch!=='function'||typeof withGithub!=='function'||!db||typeof db.query!=='function') {
    return fail('EXECUTION_AUTHORITY_UNAVAILABLE','lease-scoped mechanical coalescing runtime is incomplete',null,503);
  }
  const prepared=await resolveGithubLeaseScopedWorkspace({lease_ref:leaseRef,changes:input.changes},{executionAuthority,readBranch});
  const head=prepared.workspace.observed_head;
  if(!head) return fail('MECHANICAL_COALESCE_PARENT_MISSING','mechanical coalescing requires an existing managed workspace head',{phase:'coalesce.preflight',may_have_mutated:false},409);
  const row=(await db.query(
    `SELECT idempotency_key, receipt FROM github_changeset_receipts
       WHERE repo = $1 AND branch = $2 AND commit_sha = $3 AND state = 'succeeded'
       ORDER BY updated_at DESC LIMIT 1`,
    [prepared.workspace.repository,prepared.workspace.branch,head],
  )).rows?.[0]||null;
  const parentReceipt=parseStoredJson(row?.receipt);
  const parentLeaseRef=String(parentReceipt?.execution_authority?.lease_ref||parentReceipt?.execution_authority?.lease_id||'');
  const currentLeaseRef=String(prepared.execution_authority?.lease_ref||prepared.execution_authority?.lease_id||'');
  if(!parentReceipt||!currentLeaseRef||parentLeaseRef!==currentLeaseRef) {
    return fail('MECHANICAL_COALESCE_PARENT_AUTHORITY_MISMATCH','only the lease that created the immediately preceding mechanical workspace head may replace it',{
      expected_head:head,
      expected_lease_ref:currentLeaseRef||null,
      parent_lease_ref:parentLeaseRef||null,
      phase:'coalesce.preflight',
      may_have_mutated:false,
    },409);
  }
  const coalesceRequestSha256=await sha256Text(canonicalJson({
    lease_ref:currentLeaseRef,
    changes:input.changes,
    commit_message:commitMessage,
  }));
  if(parentReceipt.coalesce_request_sha256===coalesceRequestSha256) {
    return {...parentReceipt,idempotent_replay:true};
  }
  const revalidated=await resolveGithubLeaseScopedWorkspace({lease_ref:leaseRef,changes:input.changes},{executionAuthority,readBranch});
  if(revalidated.workspace.workspace_digest!==prepared.workspace.workspace_digest||revalidated.workspace.observed_head!==head) {
    return fail('EXECUTION_AUTHORITY_STALE','managed workspace authority changed before mechanical coalescing',{
      expected_workspace_digest:prepared.workspace.workspace_digest,
      actual_workspace_digest:revalidated.workspace.workspace_digest,
      expected_head:head,
      actual_head:revalidated.workspace.observed_head,
      phase:'coalesce.preflight',
      may_have_mutated:false,
    },409);
  }
  const result=await withGithub({repo:prepared.workspace.repository,branch:prepared.workspace.branch,changes:input.changes},(github)=>coalesceGithubMechanicalChangeset({
    repo:prepared.workspace.repository,
    branch:prepared.workspace.branch,
    expected_head:head,
    changes:input.changes,
    commit_message:commitMessage,
  },{github}));
  const replacementReceipt={
    ...result,
    execution_authority:prepared.execution_authority,
    idempotency_key:row.idempotency_key,
    coalesced_from:head,
    coalesce_request_sha256:coalesceRequestSha256,
  };
  let updated;
  try {
    updated=await db.query(
      `UPDATE github_changeset_receipts
          SET commit_sha = $4, tree_sha = $5, receipt = $6::jsonb, updated_at = now()
        WHERE repo = $1 AND idempotency_key = $2 AND branch = $3
          AND commit_sha = $7 AND state = 'succeeded'
       RETURNING idempotency_key`,
      [prepared.workspace.repository,row.idempotency_key,prepared.workspace.branch,result.commit_sha,result.tree_sha,canonicalJson(replacementReceipt),head],
    );
  } catch(error) {
    return fail('GITHUB_COALESCE_RECEIPT_WRITE_FAILED','mechanical coalescing changed GitHub state but durable replay evidence could not be written',{
      expected_head:head,
      replacement_head:result.commit_sha,
      phase:'coalesce.receipt',
      may_have_mutated:true,
      cause:String(error?.message||error),
    },503);
  }
  if(Number(updated?.rowCount||0)!==1) {
    return fail('GITHUB_COALESCE_RECEIPT_FENCE_LOST','mechanical coalescing changed GitHub state but lost the exact predecessor receipt fence',{
      expected_head:head,
      replacement_head:result.commit_sha,
      phase:'coalesce.receipt',
      may_have_mutated:true,
    },409);
  }
  return replacementReceipt;
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
  const shared={executionAuthority,readBranch,withGithub,applyChangeset,db,run_id:runId};
  return Object.freeze({
    applyChangeset(request){
      return applyGithubLeaseScopedChangeset(request,shared);
    },
    coalesceChangeset(request){
      return coalesceGithubLeaseScopedChangeset(request,shared);
    },
    applyTextReplacements(request){
      return applyGithubLeaseScopedTextReplacements(request,{...shared,readTextAtRef});
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
