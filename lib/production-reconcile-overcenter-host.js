import { canonicalJson, sha256Text } from './canonical-json.js';
import { executeProductionMaterialization } from './production-materialization-execution.js';
import { reconcileProduction } from './production-reconcile-operation.js';
import { dispatchGitHubWorkflowWithGitHubApp } from './github-workflow-dispatch.js';
// GitHub App auth is injected by the composition root.
import { productionPromotionFor } from './production-promotion-overcenter-host.js';

const SHA40 = /^[0-9a-f]{40}$/;
const VERIFICATION_WORKFLOW = 'exact-revision-v8.yml';
const RUNTIME_OBSERVATION_WORKFLOW = 'production-runtime-observation.yml';
const MATERIALIZATION_WORKFLOW = 'production-materialization.yml';
const GITHUB_READ_HEADERS = Object.freeze({ Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2026-03-10', 'User-Agent':'Overcenter/1.0' });
function fail(code, message, details = null, mayHaveMutated = false) { throw Object.assign(new Error(message), { code, details, may_have_mutated:mayHaveMutated, mayHaveMutated }); }
function repositoryParts(repo) { const value = typeof repo === 'string' ? repo.trim() : ''; if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) fail('PRODUCTION_RECONCILIATION_REQUEST_INVALID','repo must be owner/repository'); return { repo:value, [Symbol.iterator]:function*(){ yield* value.split('/'); } }; }
function bodyOf(response) { return response?.body && typeof response.body === 'object' ? response.body : response; }
function exactSha(value, field) { const revision = typeof value === 'string' ? value.trim().toLowerCase() : ''; if (!SHA40.test(revision)) fail('PRODUCTION_RECONCILIATION_GITHUB_EVIDENCE_INVALID',`${field} is not an exact Git revision`); return revision; }
function statusState(run) { const status=String(run?.status||'').toLowerCase(); if(['queued','waiting','requested'].includes(status)) return 'queued'; if(['in_progress','pending'].includes(status)) return 'in_progress'; return status; }
function exactRuns(body, revision) { return (Array.isArray(body?.workflow_runs)?body.workflow_runs:[]).filter(run=>typeof run?.head_sha==='string'&&run.head_sha.toLowerCase()===revision).sort((a,b)=>Number(b?.id||0)-Number(a?.id||0)); }
async function github(repo, capability, callback, withApp) { if(typeof withApp!=='function') fail('RUNTIME_PROVIDER_MISSING','GitHub App auth provider is required',{provider:'githubAppAuth'}); return withApp(repo,callback,{permissionProfile:capability}); }

export function productionReconciliationFor(options={}) {
  if(options.ports) return { reconcile:(input)=>reconcileProduction(input,options.ports) };
  const db=options.db;
  if(!db||typeof db.query!=='function') fail('PRODUCTION_RECONCILIATION_RUNTIME_UNAVAILABLE','database binding is required');
  const withApp=options.withGitHubAppApiClient;
  if(typeof withApp!=='function') fail('RUNTIME_PROVIDER_MISSING','GitHub App auth provider is required',{provider:'githubAppAuth'});
  const promotion=options.productionPromotion||null;
  const executionTransactionStore=options.executionTransactionStore||null;
  const runId=options.runId||null;
  const dispatchWorkflow=options.dispatchWorkflow||dispatchGitHubWorkflowWithGitHubApp;
  const sleep=typeof options.sleep==='function'?options.sleep:(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
  const pollAttempts=Number.isSafeInteger(options.pollAttempts)&&options.pollAttempts>0?options.pollAttempts:32;
  const pollDelayMs=Number.isSafeInteger(options.pollDelayMs)&&options.pollDelayMs>=0?options.pollDelayMs:750;
  async function withRuntimeGitHubApp(repo,callback,clientOptions){ return withApp(repo,callback,clientOptions); }
  async function resolveBranchRoles(repo){ const result=await db.query('SELECT development_branch, production_branch FROM portfolio_repository_branch_roles WHERE repository = $1 LIMIT 1',[repo]); const row=result?.rows?.[0]; const development=typeof row?.development_branch==='string'?row.development_branch.trim():''; const production=typeof row?.production_branch==='string'?row.production_branch.trim():''; if(!development||!production||development===production) fail('PRODUCTION_RECONCILIATION_BRANCH_ROLES_INVALID','repository branch roles are unavailable or invalid'); return {development,production}; }
  async function readRef(repo,branch){ const {repo:value}=repositoryParts(repo); const [owner,name]=value.split('/'); const response=await github(value,'project_facts',client=>client.call('github',{method:'GET',path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,headers:GITHUB_READ_HEADERS}),withApp); return exactSha(bodyOf(response)?.object?.sha,`refs/heads/${branch}`); }
  async function readBranchHeads(repo,roles){ const [development_revision,production_revision]=await Promise.all([readRef(repo,roles.development),readRef(repo,roles.production)]); return {development_revision,production_revision}; }
  async function listWorkflowRuns(repo,workflow,branch){ const {repo:value}=repositoryParts(repo); const [owner,name]=value.split('/'); const response=await github(value,'actions_storage_read',client=>client.call('github',{method:'GET',path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/${encodeURIComponent(workflow)}/runs`,query:{branch,per_page:100},headers:GITHUB_READ_HEADERS}),withApp); return bodyOf(response); }
  async function readWorkflowRun(repo,runId){ const {repo:value}=repositoryParts(repo); const [owner,name]=value.split('/'); return bodyOf(await github(value,'actions_storage_read',client=>client.call('github',{method:'GET',path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${runId}`,headers:GITHUB_READ_HEADERS}),withApp)); }
  async function readWorkflowRunJobs(repo,runId){ const {repo:value}=repositoryParts(repo); const [owner,name]=value.split('/'); return bodyOf(await github(value,'actions_storage_read',client=>client.call('github',{method:'GET',path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${runId}/jobs`,headers:GITHUB_READ_HEADERS}),withApp)); }
  async function verifyDevelopmentRevision(repo,revision,roles){ const body=await listWorkflowRuns(repo,VERIFICATION_WORKFLOW,roles.development); const run=exactRuns(body,revision).find(candidate=>String(candidate?.event||'')==='push'&&String(candidate?.status||'')==='completed'&&String(candidate?.conclusion||'')==='success'); return run?{revision,verified:true,verification_ref:`github-actions-run:${run.id}`}:{revision,verified:false,verification_ref:null}; }
  function validateRun(run,runId,revision,roles,kind){ if(Number(run?.id)!==runId) fail(`PRODUCTION_RECONCILIATION_${kind}_RUN_MISMATCH`,'GitHub returned a different workflow run than the confirmed dispatch'); if(exactSha(run?.head_sha,`${kind.toLowerCase()}_run.head_sha`)!==revision) fail(`PRODUCTION_RECONCILIATION_${kind}_RUN_MISMATCH`,'workflow run is not bound to the selected revision'); const branch=typeof run?.head_branch==='string'?run.head_branch.trim():''; if(branch&&branch!==roles.production) fail(`PRODUCTION_RECONCILIATION_${kind}_RUN_MISMATCH`,'workflow run is not bound to production branch'); if(String(run?.event||'').trim()!=='workflow_dispatch'&&kind==='OBSERVATION') fail('PRODUCTION_RECONCILIATION_OBSERVATION_RUN_MISMATCH','runtime observation must be a workflow_dispatch run'); }
  async function dispatchExact(repo,workflow,revision,roles,kind){ try { const result=await dispatchWorkflow({repo,workflow,ref:roles.production,expected_head:revision,inputs:{exact_revision:revision}},{withGitHubAppApiClient:withRuntimeGitHubApp,sleep}); const runId=Number(result?.workflow_run_id||0); if(!Number.isSafeInteger(runId)||runId<1) fail(`PRODUCTION_RECONCILIATION_${kind}_DISPATCH_INDETERMINATE`,'GitHub dispatch identity confirmation returned no trackable workflow run id',null,true); return runId; } catch(error){ if(error&&typeof error==='object'){ error.code=error.code||`PRODUCTION_RECONCILIATION_${kind}_DISPATCH_INDETERMINATE`; error.may_have_mutated=error.may_have_mutated!==false; error.mayHaveMutated=error.may_have_mutated; } throw error; } }
  async function observeRuntime(repo,revision,roles){ const runId=await dispatchExact(repo,RUNTIME_OBSERVATION_WORKFLOW,revision,roles,'OBSERVATION'); for(let attempt=0;attempt<pollAttempts;attempt+=1){ const run=await readWorkflowRun(repo,runId); validateRun(run,runId,revision,roles,'OBSERVATION'); const state=statusState(run); if(state==='completed'){ if(String(run?.conclusion||'')!=='success') fail('PRODUCTION_RECONCILIATION_OBSERVATION_FAILED','authoritative runtime observation workflow failed'); const body=await readWorkflowRunJobs(repo,runId); const jobs=Array.isArray(body?.jobs)?body.jobs:[]; const job=jobs.find(candidate=>String(candidate?.name||'').trim()==='observe'); const steps=Array.isArray(job?.steps)?job.steps:[]; const current=steps.find(step=>String(step?.name||'').trim()==='Runtime current'); const stale=steps.find(step=>String(step?.name||'').trim()==='Runtime stale'); if(String(current?.conclusion||'')==='success'&&String(stale?.conclusion||'')==='skipped') return {revision,verified:true,verification_ref:`github-actions-run:${runId}`,deployment_version:null}; if(String(stale?.conclusion||'')==='success'&&String(current?.conclusion||'')==='skipped') return {revision:null,verified:false,verification_ref:`github-actions-run:${runId}`,deployment_version:null}; fail('PRODUCTION_RECONCILIATION_OBSERVATION_RUN_MISMATCH','runtime observation run lacks one authoritative current/stale marker'); } if(!['queued','in_progress'].includes(state)) fail('PRODUCTION_RECONCILIATION_OBSERVATION_RUN_MISMATCH',`runtime observation has unsupported state ${state||'unknown'}`); if(attempt+1<pollAttempts) await sleep(pollDelayMs); } fail('PRODUCTION_RECONCILIATION_OBSERVATION_PENDING','runtime observation did not complete within the bounded poll window'); }
  async function materializationMutationAttempted(repo,runId){ const body=await readWorkflowRunJobs(repo,runId); const jobs=Array.isArray(body?.jobs)?body.jobs:[]; const job=jobs.find(candidate=>String(candidate?.name||'').trim()==='materialize'); const step=(Array.isArray(job?.steps)?job.steps:[]).find(candidate=>String(candidate?.name||'').trim()==='Materialize exact production revision'); const conclusion=String(step?.conclusion||'').trim().toLowerCase(); if(conclusion==='skipped') return false; if(conclusion==='success') return true; fail('PRODUCTION_RECONCILIATION_MATERIALIZATION_RUN_MISMATCH','successful materialization workflow lacks exact materialization-step outcome'); }
  async function pollMaterialization(repo,runId,revision,roles,mutationAttempted){ for(let attempt=0;attempt<pollAttempts;attempt+=1){ const run=await readWorkflowRun(repo,runId); validateRun(run,runId,revision,roles,'MATERIALIZATION'); const state=statusState(run); if(state==='completed'){ if(String(run?.conclusion||'')!=='success') return {state:'failed',revision,run_ref:`github-actions-run:${runId}`,mutation_attempted:mutationAttempted}; const actualMutation=await materializationMutationAttempted(repo,runId); return {state:'succeeded',revision,verification_ref:`github-actions-run:${runId}`,deployment_version:null,run_ref:`github-actions-run:${runId}`,mutation_attempted:actualMutation}; } if(!['queued','in_progress'].includes(state)) fail('PRODUCTION_RECONCILIATION_MATERIALIZATION_RUN_MISMATCH',`materialization has unsupported state ${state||'unknown'}`); if(attempt+1<pollAttempts) await sleep(pollDelayMs); } return {state:'pending',revision,run_ref:`github-actions-run:${runId}`,mutation_attempted:mutationAttempted}; }
  async function reconcileRuntimePrimitive(repo,revision,roles){ const body=await listWorkflowRuns(repo,MATERIALIZATION_WORKFLOW,roles.production); const active=exactRuns(body,revision).find(run=>['queued','in_progress'].includes(statusState(run))); if(active){ const runId=Number(active?.id); if(!Number.isSafeInteger(runId)||runId<1) fail('PRODUCTION_RECONCILIATION_MATERIALIZATION_RUN_MISMATCH','active materialization run has no stable identity'); return pollMaterialization(repo,runId,revision,roles,true); } const runId=await dispatchExact(repo,MATERIALIZATION_WORKFLOW,revision,roles,'MATERIALIZATION'); return pollMaterialization(repo,runId,revision,roles,true); }
  async function readExistingMaterialization(repo,revision,roles){
    const body=await listWorkflowRuns(repo,MATERIALIZATION_WORKFLOW,roles.production);
    const runs=exactRuns(body,revision);
    const candidate=runs.find(run=>['queued','in_progress'].includes(statusState(run)))||runs.find(run=>String(run?.status||'').toLowerCase()==='completed')||null;
    if(!candidate) return {state:'absent',revision,run_ref:null,mutation_attempted:false};
    const runId=Number(candidate?.id||0);
    if(!Number.isSafeInteger(runId)||runId<1) fail('PRODUCTION_RECONCILIATION_MATERIALIZATION_RUN_MISMATCH','materialization readback lacks a stable workflow identity');
    return pollMaterialization(repo,runId,revision,roles,false);
  }

  async function materializationWithKernel(repo,revision,roles){
    if(!executionTransactionStore||typeof executionTransactionStore.prepareExecution!=='function'){
      fail('EXECUTION_TRANSACTION_STORE_REQUIRED','production materialization requires the authoritative execution transaction store');
    }
    const projectRef=`github:${repo}`;
    const authorityEpoch=Number(options.authorityEpoch??0);
    if(!Number.isSafeInteger(authorityEpoch)||authorityEpoch<0){
      fail('PRODUCTION_RECONCILIATION_AUTHORITY_EPOCH_INVALID','production materialization authority epoch is invalid');
    }
    const graphFingerprint=`github.branch-roles:${roles.development}:${roles.production}`;
    const transitionFingerprint=`production-materialization:${revision}`;
    const sourceManifestSha256=await sha256Text(canonicalJson({
      schema:'production-materialization-source-v1',
      repository:repo,
      branch:roles.production,
      revision,
    }));
    const request={
      project_ref:projectRef,
      subject_key:projectRef+':materialization:'+revision,
      repository:repo,
      authority_revision:revision,
      authority_epoch:authorityEpoch,
      graph_fingerprint:graphFingerprint,
      transition_fingerprint:transitionFingerprint,
      repo,
      branch:roles.production,
      source_revision:revision,
      runtime_ref:'production:'+repo,
      expected_version:1,
      source_manifest_sha256:sourceManifestSha256,
    };
    const runId=String(options.runId||`production-materialization:${repo}:${revision}`);
    let invokedResult=null;
    const transaction=await executeProductionMaterialization(request,{
      executionTransactionStore,
      executionContext(){
        return {
          run_id:runId,
          subject_kind:'provider_operation',
          authority_epoch:authorityEpoch,
          lease_expires_at:new Date(Date.now()+60_000).toISOString(),
        };
      },
      providerFor(){
        return {
          async preflight(){
            const heads=await readBranchHeads(repo,roles);
            if(heads.development_revision!==revision){
              return {provider:'github',observed_revision:heads.development_revision,provider_identity:heads};
            }
            if(heads.production_revision!==revision){
              return {provider:'github',observed_revision:'production:'+heads.production_revision,provider_identity:heads};
            }
            return {provider:'github',observed_revision:revision,provider_identity:heads};
          },
          async invoke(){
            invokedResult=await reconcileRuntimePrimitive(repo,revision,roles);
            const evidence=invokedResult&&typeof invokedResult==='object'?invokedResult:{result:String(invokedResult)};
            const response_sha256=await sha256Text(canonicalJson(evidence));
            const runRef=String(invokedResult?.run_ref||invokedResult?.verification_ref||'').trim();
            const effect_ref=invokedResult?.state==='succeeded'&&runRef
              ? 'github-actions-materialization:'+repo+'@'+revision+'#'+runRef
              : null;
            if(invokedResult?.state==='succeeded'&&effect_ref){
              return {transport:'accepted',committed:true,effect_ref,response_sha256,evidence};
            }
            if(invokedResult?.state==='failed'&&invokedResult?.mutation_attempted!==true){
              return {transport:'rejected',committed:false,effect_ref:null,response_sha256,evidence};
            }
            return {transport:'unknown',committed:null,effect_ref:null,response_sha256:null,evidence};
          },
          async confirm(){
            let observed;
            try { observed=await readExistingMaterialization(repo,revision,roles); }
            catch(error){
              return {status:'unknown',effect_ref:null,predicate:'production-materialization-readback',evidence:{error:String(error?.message||error)}};
            }
            const runRef=String(observed?.run_ref||observed?.verification_ref||'').trim();
            if(observed?.state==='succeeded'&&runRef){
              return {
                status:'confirmed',
                effect_ref:'github-actions-materialization:'+repo+'@'+revision+'#'+runRef,
                predicate:'production-materialization-workflow-succeeded',
                evidence:observed,
              };
            }
            if(observed?.state==='absent'||(observed?.state==='failed'&&observed?.mutation_attempted!==true)){
              return {
                status:'absent',
                effect_ref:null,
                predicate:'production-materialization-workflow-absent',
                evidence:observed,
              };
            }
            return {
              status:'unknown',
              effect_ref:null,
              predicate:'production-materialization-readback',
              evidence:observed,
            };
          },
        };
      },
    });
    if(transaction.receipt.disposition==='completed'){
      if(invokedResult?.state==='succeeded') return invokedResult;
      return {
        state:'succeeded',
        revision,
        verification_ref:invokedResult?.verification_ref||transaction.receipt.effect_ref,
        deployment_version:invokedResult?.deployment_version??null,
        run_ref:invokedResult?.run_ref||transaction.receipt.effect_ref,
        mutation_attempted:true,
      };
    }
    if(invokedResult?.state==='failed'&&invokedResult?.mutation_attempted!==true) return invokedResult;
    return {
      state:'failed',
      revision,
      run_ref:invokedResult?.run_ref||null,
      mutation_attempted:false,
    };
  }

  const ports={ resolveBranchRoles,readBranchHeads,verifyDevelopmentRevision,observeRuntime,promote:async(input)=>{ if(promotion)return promotion.promote(input); return productionPromotionFor({db,withGitHubAppClient:withApp,executionTransactionStore,runId}).promote(input); },reconcileRuntime:(repo,revision,roles)=>materializationWithKernel(repo,revision,roles) };
  return { reconcile:(input)=>reconcileProduction(input,ports) };
}