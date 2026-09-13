import { closeGithubWorkSurface, closeGithubPullRequestWithGitHubApp, closeGithubIssueWithGitHubApp } from './github-work-surface-close.js';

function check(value,message){ if(!value) throw new Error(message); }
function response(object){ return { status:200, headers:{}, body:{ data:{ repository: object.kind === 'pull_request' ? { id:'R', pullRequest:{ id:'PR', number:object.number, state:object.state, merged:Boolean(object.merged), headRefOid:object.head_sha, url:'https://example/pr' } } : { id:'R', issue:{ id:'I', number:object.number, state:object.state, url:'https://example/issue' } } } } }; }

async function run(name,fn){ try{await fn(); return {name,ok:true};}catch(error){return {name,ok:false,error:String(error?.message||error)};} }

export async function runGithubWorkSurfaceCloseTests(){
 const tests=[];
 tests.push(await run('pull request close preflights exact head and verifies closure',async()=>{
   let reads=0,mutations=0;
   const api={ graphql:async(query)=>{ if(query.includes('mutation ClosePullRequest')){mutations++;return {status:200,headers:{},body:{data:{closePullRequest:{pullRequest:{id:'PR'}}}}};} reads++; return response({kind:'pull_request',number:7,state:reads===1?'OPEN':'CLOSED',head_sha:'a'.repeat(40)}); } };
   const result=await closeGithubWorkSurface('pull_request',{repo:'o/r',pull_request:7,expected_head:'a'.repeat(40),artifact_ref:'artifact:pr:7'},{apiClient:api});
   check(result.ok && result.outcome==='closed','pull request did not close'); check(mutations===1,'mutation count was not one');
 }));
 tests.push(await run('already closed issue is idempotent',async()=>{
   let mutations=0; const api={graphql:async(query)=>{if(query.includes('mutation'))mutations++;return response({kind:'issue',number:9,state:'CLOSED'});}};
   const result=await closeGithubWorkSurface('issue',{repo:'o/r',issue:9,artifact_ref:'artifact:issue:9'},{apiClient:api});
   check(result.ok && result.outcome==='already_closed' && mutations===0,'already-closed issue mutated');
 }));
 tests.push(await run('pull request head drift fails closed before mutation',async()=>{
   let mutations=0; const api={graphql:async(query)=>{if(query.includes('mutation'))mutations++;return response({kind:'pull_request',number:2,state:'OPEN',head_sha:'b'.repeat(40)});}};
   const result=await closeGithubWorkSurface('pull_request',{repo:'o/r',pull_request:2,expected_head:'a'.repeat(40),artifact_ref:'artifact:pr:2'},{apiClient:api});
   check(!result.ok && result.error==='HEAD_MISMATCH' && result.may_have_mutated===false && mutations===0,'head drift did not fail closed');
 }));
 tests.push(await run('transport loss reconciles instead of blindly retrying mutation',async()=>{
   let reads=0,mutations=0; const api={graphql:async(query)=>{if(query.includes('mutation CloseIssue')){mutations++;throw new Error('lost response');} reads++; return response({kind:'issue',number:4,state:reads===1?'OPEN':'CLOSED'});}};
   const result=await closeGithubWorkSurface('issue',{repo:'o/r',issue:4,artifact_ref:'artifact:issue:4'},{apiClient:api});
   check(result.ok && result.reconciled_after_indeterminate===true && mutations===1,'indeterminate close was retried or not reconciled');
 }));
 tests.push(await run('artifact identity is mandatory',async()=>{
   const result=await closeGithubWorkSurface('issue',{repo:'o/r',issue:4},{apiClient:{graphql:async()=>{throw new Error('must not call');}}});
   check(!result.ok && result.error==='INVALID_ARTIFACT_REF' && result.may_have_mutated===false,'artifact identity was not required');
 }));
 tests.push(await run('GitHub App wrappers request narrow kind-specific permission profiles',async()=>{
   const profiles=[];
   const withGitHubAppApiClient=async(_repo,callback,options)=>{
     profiles.push(options?.permissionProfile);
     let reads=0;
     return callback({graphql:async(query)=>{
       const isPull=query.includes('PullRequest');
       if(query.includes('mutation')) return {status:200,headers:{},body:{data:isPull?{closePullRequest:{pullRequest:{id:'PR'}}}:{closeIssue:{issue:{id:'I'}}}}};
       reads++;
       return response(isPull?{kind:'pull_request',number:5,state:reads===1?'OPEN':'CLOSED',head_sha:'a'.repeat(40)}:{kind:'issue',number:6,state:reads===1?'OPEN':'CLOSED'});
     }});
   };
   const pr=await closeGithubPullRequestWithGitHubApp({repo:'o/r',pull_request:5,expected_head:'a'.repeat(40),artifact_ref:'artifact:pr:5'},{withGitHubAppApiClient});
   const issue=await closeGithubIssueWithGitHubApp({repo:'o/r',issue:6,artifact_ref:'artifact:issue:6'},{withGitHubAppApiClient});
   check(pr.ok && issue.ok,'wrapper close failed');
   check(JSON.stringify(profiles)===JSON.stringify(['pull_request_close','issue_close']),'close commands did not request least-privilege permission profiles');
 }));
 return {ok:tests.every((t)=>t.ok),passed:tests.filter((t)=>t.ok).length,failed:tests.filter((t)=>!t.ok).length,tests};
}

if(import.meta.url===`file://${process.argv[1]}`){ const result=await runGithubWorkSurfaceCloseTests(); console.log(JSON.stringify(result,null,2)); if(!result.ok) process.exitCode=1; }
