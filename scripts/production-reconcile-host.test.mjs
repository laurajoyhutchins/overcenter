import test from 'node:test';
import assert from 'node:assert/strict';
import { productionReconciliationFor } from '../lib/production-reconcile-overcenter-host.js';

const SHA='a'.repeat(40);
const rolesDb={query:async()=>({rows:[{development_branch:'dev',production_branch:'main'}]})};
function githubReads({observationRun=101,observationCurrent=true,materializationRun=null}={}){
  const calls=[];
  const withGitHubAppApiClient=async(_repo,callback)=>callback({call:async(_provider,request)=>{
    calls.push(request);
    if(request.path.includes('/git/ref/heads/')) return {status:200,body:{object:{sha:SHA}}};
    if(request.path.includes('/actions/workflows/exact-revision-v8.yml/runs')) return {status:200,body:{workflow_runs:[{id:1,head_sha:SHA,event:'push',status:'completed',conclusion:'success'}]}};
    if(request.path.includes('/actions/workflows/production-materialization.yml/runs')) return {status:200,body:{workflow_runs:[]}};
    if(request.path.endsWith(`/actions/runs/${observationRun}`)) return {body:{id:observationRun,head_sha:SHA,head_branch:'main',event:'workflow_dispatch',status:'completed',conclusion:'success'}};
    if(request.path.endsWith(`/actions/runs/${observationRun}/jobs`)) return {body:{jobs:[{name:'observe',steps:[{name:'Runtime current',conclusion:observationCurrent?'success':'skipped'},{name:'Runtime stale',conclusion:observationCurrent?'skipped':'success'}]}]}};
    if(materializationRun&&request.path.endsWith(`/actions/runs/${materializationRun}`)) return {body:{id:materializationRun,head_sha:SHA,head_branch:'main',event:'workflow_dispatch',status:'queued',conclusion:null}};
    throw new Error(`unexpected GitHub request ${request.path}`);
  }});
  return {calls,withGitHubAppApiClient};
}

test('repo-only host derives mechanical coordinates internally',async()=>{
  const calls=[];
  const service=productionReconciliationFor({ports:{
    resolveBranchRoles:async repo=>{calls.push(['roles',repo]);return {development:'dev',production:'main'};},
    readBranchHeads:async repo=>{calls.push(['heads',repo]);return {development_revision:SHA,production_revision:SHA};},
    verifyDevelopmentRevision:async(_repo,revision)=>({revision,verified:true,verification_ref:'github-actions-run:1'}),
    observeRuntime:async(_repo,revision)=>({revision,verified:true,verification_ref:'github-actions-run:2',deployment_version:null}),
    promote:async()=>{throw new Error('unexpected promotion');},
    reconcileRuntime:async()=>{throw new Error('unexpected materialization');},
  }});
  const result=await service.reconcile({repo:'laurajoyhutchins/overcenter'});
  assert.equal(result.outcome,'already_converged');
  assert.deepEqual(calls[0],['roles','laurajoyhutchins/overcenter']);
});

test('fresh invocation observes immutable Hatchable authority without process-local runtime cache',async()=>{
  const {calls,withGitHubAppApiClient}=githubReads();
  const dispatches=[];
  const service=productionReconciliationFor({db:rolesDb,withGitHubAppApiClient,dispatchWorkflow:async input=>{dispatches.push(input);return {workflow_run_id:101};},productionPromotion:{promote:async()=>{throw new Error('already-current Git must not promote');}},sleep:async()=>{}});
  const result=await service.reconcile({repo:'laurajoyhutchins/overcenter'});
  assert.equal(result.outcome,'already_converged');
  assert.equal(result.runtime_revision,SHA);
  assert.equal(result.runtime_verification_ref,'github-actions-run:101');
  assert.equal(dispatches.length,1);
  assert.equal(dispatches[0].workflow,'production-runtime-observation.yml');
  assert.deepEqual(dispatches[0].inputs,{exact_revision:SHA});
  assert.ok(calls.some(request=>request.path.endsWith('/actions/runs/101/jobs')));
});

test('stale runtime observation cannot authorize convergence and hands off to materialization',async()=>{
  const {withGitHubAppApiClient}=githubReads({observationRun:102,observationCurrent:false,materializationRun:103});
  const dispatches=[];
  const service=productionReconciliationFor({db:rolesDb,withGitHubAppApiClient,dispatchWorkflow:async input=>{dispatches.push(input);return {workflow_run_id:input.workflow==='production-runtime-observation.yml'?102:103};},productionPromotion:{promote:async()=>{throw new Error('already-current Git must not promote');}},pollAttempts:1,pollDelayMs:0,sleep:async()=>{}});
  const result=await service.reconcile({repo:'laurajoyhutchins/overcenter'});
  assert.equal(result.outcome,'materialization_pending');
  assert.equal(result.materialization_run_ref,'github-actions-run:103');
  assert.deepEqual(dispatches.map(item=>item.workflow),['production-runtime-observation.yml','production-materialization.yml']);
});

test('workflow_dispatch 204 identity is recovered by the canonical dispatch capability',async()=>{
  const requests=[];
  let runLists=0;
  const withGitHubAppApiClient=async(_repo,callback)=>callback({call:async(_provider,request)=>{
    requests.push(request);
    if(request.path.includes('/git/ref/heads/')) return {status:200,body:{object:{sha:SHA}}};
    if(request.path.includes('/actions/workflows/exact-revision-v8.yml/runs')) return {status:200,body:{workflow_runs:[{id:1,head_sha:SHA,event:'push',status:'completed',conclusion:'success'}]}};
    if(request.path.includes('/actions/workflows/production-runtime-observation.yml/dispatches')) return {status:204,body:null};
    if(request.path.includes('/actions/workflows/production-runtime-observation.yml/runs')) {runLists+=1;return {status:200,body:{workflow_runs:[{id:104,head_sha:SHA,head_branch:'main',event:'workflow_dispatch',status:'completed',conclusion:'success',created_at:new Date().toISOString()}]}};}
    if(request.path.endsWith('/actions/runs/104')) return {body:{id:104,head_sha:SHA,head_branch:'main',event:'workflow_dispatch',status:'completed',conclusion:'success'}};
    if(request.path.endsWith('/actions/runs/104/jobs')) return {body:{jobs:[{name:'observe',steps:[{name:'Runtime current',conclusion:'success'},{name:'Runtime stale',conclusion:'skipped'}]}]}};
    throw new Error(`unexpected GitHub request ${request.path}`);
  }});
  const service=productionReconciliationFor({db:rolesDb,withGitHubAppApiClient,productionPromotion:{promote:async()=>{throw new Error('unexpected promotion');}},sleep:async()=>{}});
  const result=await service.reconcile({repo:'laurajoyhutchins/overcenter'});
  assert.equal(result.outcome,'already_converged');
  assert.equal(result.runtime_verification_ref,'github-actions-run:104');
  assert.ok(runLists>=1);
  assert.ok(requests.some(request=>request.path.includes('/dispatches')&&request.method==='POST'));
});

test('GitHub reads use the canonical GET transport contract',async()=>{
  const calls=[];
  const withGitHubAppApiClient=async(_repo,callback)=>callback({call:async(_provider,request)=>{calls.push(request);if(request.path.includes('/git/ref/heads/'))return {status:200,body:{object:{sha:SHA}}};if(request.path.includes('/actions/workflows/exact-revision-v8.yml/runs'))return {status:200,body:{workflow_runs:[]}};throw new Error(`unexpected ${request.path}`);}});
  const service=productionReconciliationFor({db:rolesDb,withGitHubAppApiClient});
  await assert.rejects(service.reconcile({repo:'laurajoyhutchins/overcenter'}),error=>error?.code==='PRODUCTION_RECONCILIATION_SOURCE_NOT_VERIFIED');
  for(const request of calls){assert.equal(request.method,'GET');assert.equal(request.headers?.Accept,'application/vnd.github+json');assert.equal(request.headers?.['X-GitHub-Api-Version'],'2026-03-10');assert.equal(request.headers?.['User-Agent'],'Overcenter/1.0');}
});