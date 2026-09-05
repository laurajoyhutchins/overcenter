import { db as hatchableDb } from 'hatchable';
import { applyGithubChangesetRoleAware } from 'lib/github-branch-role-runtime.js';
import { createPostgresExecutionAuthorityService } from 'lib/execution-authority.js';
import { createGithubApiAdapter } from 'lib/github-apply-changeset.js';
import { githubAppChangesetPermissionProfile, withGitHubAppApiClient } from 'lib/github-app-auth.js';
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

async function defaultWithGithub({repo,changes=[]},callback){
  return withGitHubAppApiClient(repo,async(apiClient)=>callback(createGithubApiAdapter(apiClient)),{
    permissionProfile:permissionProfileForChanges(changes),
  });
}

async function defaultReadBranch(request){
  return defaultWithGithub(request,(github)=>github.getBranch(request.repo,request.branch,{phase:'lease_scope.workspace_head'}));
}

async function defaultReadTextAtRef({repo,ref,path}){
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
  const db=options.db||hatchableDb;
  const executionAuthority=options.executionAuthority||createPostgresExecutionAuthorityService({db});
  const readBranch=options.readBranch||defaultReadBranch;
  const withGithub=options.withGithub||defaultWithGithub;
  const readTextAtRef=options.readTextAtRef||defaultReadTextAtRef;
  const applyChangeset=options.applyChangeset||applyGithubChangesetRoleAware;
  const runId=options.run_id||null;
  const shared={executionAuthority,readBranch,withGithub,applyChangeset,db,run_id:runId};
  return Object.freeze({
    applyChangeset(request){
      return applyGithubLeaseScopedChangeset(request,shared);
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
