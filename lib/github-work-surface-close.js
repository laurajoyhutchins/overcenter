import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';

const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40=/^[0-9a-f]{40}$/;

function fail(error,message,details={}){return {ok:false,error,message,...details};}
function artifactRef(value){const ref=typeof value==='string'?value.trim():'';return ref&&ref.length<=1024?ref:null;}
function common(input,kind){
 if(!input||typeof input!=='object'||Array.isArray(input)) return fail('INVALID_REQUEST','request must be an object');
 const allowed=new Set(kind==='pull_request'?['repo','pull_request','expected_head','artifact_ref','run_id']:['repo','issue','artifact_ref','run_id']);
 const unknown=Object.keys(input).filter(k=>!allowed.has(k)).sort(); if(unknown.length)return fail('INVALID_REQUEST','request contains unknown fields',{unknown});
 const repo=String(input.repo||'').trim(); if(!REPO.test(repo))return fail('INVALID_REPOSITORY','repo must be owner/repo');
 const number=Number(input[kind]); if(!Number.isInteger(number)||number<1)return fail('INVALID_PROVIDER_OBJECT',`${kind} must be a positive integer`);
 const artifact_ref=artifactRef(input.artifact_ref); if(!artifact_ref)return fail('INVALID_ARTIFACT_REF','artifact_ref must be a bounded non-empty semantic artifact identity');
 const out={ok:true,repo,[kind]:number,artifact_ref};
 if(kind==='pull_request'){const expected_head=String(input.expected_head||'').trim().toLowerCase();if(!SHA40.test(expected_head))return fail('INVALID_SHA','expected_head must be a full 40-character Git commit SHA');out.expected_head=expected_head;}
 return out;
}
export function normalizeGithubPullRequestCloseRequest(input){return common(input,'pull_request');}
export function normalizeGithubIssueCloseRequest(input){return common(input,'issue');}

function transportFailure(response,kind,phase,may=false){
 const status=Number(response?.status||0); const message=String(response?.body?.message||`GitHub returned HTTP ${status||'unknown'}`);
 const evidence=githubTransportEvidence(response,{phase,attempts:1,mayHaveMutated:may});
 if(status===401||status===403)return fail('GITHUB_PERMISSION_DENIED',message,{upstream_status:status,...evidence});
 if(status===404)return fail('GITHUB_NOT_FOUND',message,{upstream_status:status,...evidence});
 return fail(may?`GITHUB_${kind.toUpperCase()}_CLOSE_INDETERMINATE`:'GITHUB_UPSTREAM_ERROR',message,{...(status?{upstream_status:status}:{}),...evidence});
}
async function read(api,path,kind,phase,options={}){
 try{const retried=await boundedSafeRead(()=>api.call('github',{path,method:'GET'}),{sleep:options.sleep,random:options.random,maxAttempts:options.maxAttempts||3});const r=retried.response;if(!r||r.status<200||r.status>=300)return transportFailure(r,kind,phase,false);return {ok:true,body:r.body,attempts:retried.attempts};}
 catch(error){return fail('GITHUB_UPSTREAM_ERROR',String(error?.message||'GitHub read failed'),{phase,attempts:Number(error?.githubTransportAttempts||1),may_have_mutated:false});}
}
function publicPr(body){return {number:Number(body?.number),state:String(body?.state||'').toLowerCase(),head_sha:String(body?.head?.sha||'').toLowerCase(),merged:Boolean(body?.merged),url:body?.html_url?String(body.html_url):null};}
function publicIssue(body){return {number:Number(body?.number),state:String(body?.state||'').toLowerCase(),is_pull_request:Boolean(body?.pull_request),url:body?.html_url?String(body.html_url):null};}
function success(n,observed,outcome,extra={}){return {ok:true,outcome,...n,state:observed.state,url:observed.url,...extra};}

async function closePullRequest(n,options={}){
 const api=options.apiClient;if(!api||typeof api.call!=='function')return fail('GITHUB_TRANSPORT_UNAVAILABLE','A GitHub REST transport is required.');
 const path=`/repos/${n.repo}/pulls/${n.pull_request}`; const beforeRead=await read(api,path,'pull_request','preflight',options);if(!beforeRead.ok)return beforeRead;const before=publicPr(beforeRead.body);
 if(before.number!==n.pull_request)return fail('GITHUB_PROVIDER_IDENTITY_MISMATCH','GitHub returned a different pull request identity',{may_have_mutated:false});
 if(before.head_sha!==n.expected_head)return fail('HEAD_MISMATCH','The pull request head does not match expected_head',{expected_head:n.expected_head,actual_head:before.head_sha,may_have_mutated:false});
 if(before.state==='closed'||before.merged)return success(n,before,'already_closed',{mutation_attempted:false});
 let mutation;
 try{mutation=await api.call('github',{path,method:'PATCH',body:{state:'closed'}});}catch(error){return reconcilePr(api,n,path,options,{transport_error:String(error?.message||error)});}
 if(!mutation||mutation.status<200||mutation.status>=300){const f=transportFailure(mutation,'pull_request','close',mutation?.status>=500);if(f.error==='GITHUB_PULL_REQUEST_CLOSE_INDETERMINATE')return reconcilePr(api,n,path,options,f);return f;}
 const afterRead=await read(api,path,'pull_request','post_mutation_verify',options);if(!afterRead.ok)return fail('GITHUB_PULL_REQUEST_CLOSE_INDETERMINATE','GitHub acknowledged closure but authoritative readback failed',{may_have_mutated:true,verification_error:afterRead});const after=publicPr(afterRead.body);
 if(after.number!==n.pull_request||after.head_sha!==n.expected_head||after.state!=='closed')return fail('GITHUB_PULL_REQUEST_CLOSE_INDETERMINATE','Authoritative readback does not prove exact-head pull request closure',{may_have_mutated:true,actual_head:after.head_sha,observed_state:after.state});
 return success(n,after,'closed',{mutation_attempted:true,reconciled_after_indeterminate:false});
}
async function reconcilePr(api,n,path,options,evidence){const r=await read(api,path,'pull_request','reconcile_after_indeterminate',options);if(!r.ok)return fail('GITHUB_PULL_REQUEST_CLOSE_INDETERMINATE','Mutation may have completed and reconciliation failed',{may_have_mutated:true,mutation_evidence:evidence,reconciliation_error:r});const p=publicPr(r.body);if(p.number===n.pull_request&&p.head_sha===n.expected_head&&p.state==='closed')return success(n,p,'closed',{mutation_attempted:true,reconciled_after_indeterminate:true,mutation_evidence:evidence});return fail('GITHUB_PULL_REQUEST_CLOSE_INDETERMINATE','Mutation may have completed but exact authoritative closure is unproven',{may_have_mutated:true,mutation_evidence:evidence,actual_head:p.head_sha,observed_state:p.state});}

async function closeIssue(n,options={}){
 const api=options.apiClient;if(!api||typeof api.call!=='function')return fail('GITHUB_TRANSPORT_UNAVAILABLE','A GitHub REST transport is required.');
 const path=`/repos/${n.repo}/issues/${n.issue}`; const beforeRead=await read(api,path,'issue','preflight',options);if(!beforeRead.ok)return beforeRead;const before=publicIssue(beforeRead.body);
 if(before.number!==n.issue||before.is_pull_request)return fail('GITHUB_PROVIDER_IDENTITY_MISMATCH','github.issue.close requires an exact issue object, not a pull request',{may_have_mutated:false});
 if(before.state==='closed')return success(n,before,'already_closed',{mutation_attempted:false});
 let mutation;try{mutation=await api.call('github',{path,method:'PATCH',body:{state:'closed'}});}catch(error){return reconcileIssue(api,n,path,options,{transport_error:String(error?.message||error)});}
 if(!mutation||mutation.status<200||mutation.status>=300){const f=transportFailure(mutation,'issue','close',mutation?.status>=500);if(f.error==='GITHUB_ISSUE_CLOSE_INDETERMINATE')return reconcileIssue(api,n,path,options,f);return f;}
 const afterRead=await read(api,path,'issue','post_mutation_verify',options);if(!afterRead.ok)return fail('GITHUB_ISSUE_CLOSE_INDETERMINATE','GitHub acknowledged closure but authoritative readback failed',{may_have_mutated:true,verification_error:afterRead});const after=publicIssue(afterRead.body);
 if(after.number!==n.issue||after.is_pull_request||after.state!=='closed')return fail('GITHUB_ISSUE_CLOSE_INDETERMINATE','Authoritative readback does not prove exact issue closure',{may_have_mutated:true,observed_state:after.state});
 return success(n,after,'closed',{mutation_attempted:true,reconciled_after_indeterminate:false});
}
async function reconcileIssue(api,n,path,options,evidence){const r=await read(api,path,'issue','reconcile_after_indeterminate',options);if(!r.ok)return fail('GITHUB_ISSUE_CLOSE_INDETERMINATE','Mutation may have completed and reconciliation failed',{may_have_mutated:true,mutation_evidence:evidence,reconciliation_error:r});const i=publicIssue(r.body);if(i.number===n.issue&&!i.is_pull_request&&i.state==='closed')return success(n,i,'closed',{mutation_attempted:true,reconciled_after_indeterminate:true,mutation_evidence:evidence});return fail('GITHUB_ISSUE_CLOSE_INDETERMINATE','Mutation may have completed but authoritative issue closure is unproven',{may_have_mutated:true,mutation_evidence:evidence,observed_state:i.state});}

function authFailure(error,kind){const message=String(error?.message||'GitHub App authentication failed.');if(/config\/get 412|declared as required but not set/i.test(message))return fail('GITHUB_APP_SETUP_REQUIRED','Configure the GitHub App before retiring GitHub work surfaces.');if([401,403,422].includes(Number(error?.status)))return fail('GITHUB_APP_PERMISSION_DENIED',message,{upstream_status:Number(error.status)});if(Number(error?.status)===404)return fail('GITHUB_APP_INSTALLATION_NOT_FOUND','The GitHub App is not installed for this repository.');return fail(error?.code||`GITHUB_${kind.toUpperCase()}_CLOSE_AUTH_ERROR`,message);}
export async function closeGithubPullRequest(input,options={}){const n=normalizeGithubPullRequestCloseRequest(input);if(!n.ok)return n;const withApp=options.withGitHubAppApiClient||withGitHubAppApiClient;try{return await withApp(n.repo,api=>closePullRequest(n,{...options,apiClient:api}),{permissionProfile:'pull_request_close'});}catch(error){return authFailure(error,'pull_request');}}
export async function closeGithubIssue(input,options={}){const n=normalizeGithubIssueCloseRequest(input);if(!n.ok)return n;const withApp=options.withGitHubAppApiClient||withGitHubAppApiClient;try{return await withApp(n.repo,api=>closeIssue(n,{...options,apiClient:api}),{permissionProfile:'issue_close'});}catch(error){return authFailure(error,'issue');}}
export { closePullRequest as closeGithubPullRequestWithApi, closeIssue as closeGithubIssueWithApi };