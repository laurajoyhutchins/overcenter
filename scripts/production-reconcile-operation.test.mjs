import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileProduction } from '../lib/production-reconcile-operation.js';

const DEV='a'.repeat(40);
const PROD='b'.repeat(40);
const DRIFT='c'.repeat(40);
function runtime(revision,version=506){return {revision,verified:true,verification_ref:`immutable-runtime:prod:${version}:manifest`,deployment_version:version};}
function fixture(overrides={}){
  const state={development:DEV,production:PROD,runtime:runtime(PROD,505),calls:[]};
  const ports={
    resolveBranchRoles:async()=>({development:'dev',production:'main'}),
    readBranchHeads:async()=>{state.calls.push(['heads',state.development,state.production]);return {development_revision:state.development,production_revision:state.production};},
    verifyDevelopmentRevision:async(_repo,revision)=>{state.calls.push(['verify',revision]);return {revision,verified:true,verification_ref:'github-actions-run:42'};},
    observeRuntime:async(_repo,revision)=>{state.calls.push(['runtime',revision,state.runtime.revision]);return state.runtime;},
    promote:async intent=>{state.calls.push(['promote',Object.keys(intent).sort()]);state.production=DEV;return {ok:true,source_revision:DEV,production_revision:DEV};},
    reconcileRuntime:async(_repo,revision)=>{state.calls.push(['reconcile-runtime',revision]);state.runtime=runtime(DEV,507);return {state:'succeeded',revision:DEV,verification_ref:state.runtime.verification_ref,deployment_version:507,mutation_attempted:true};},
  };
  Object.assign(ports,typeof overrides==='function'?overrides(state):overrides);
  return {state,ports};
}
async function failure(fn){try{await fn();}catch(error){return error;}assert.fail('expected failure');}

test('repo intent promotes exact verified dev then materializes and rereads Git authority',async()=>{
  const {state,ports}=fixture();
  const result=await reconcileProduction({repo:'laurajoyhutchins/overcenter'},ports);
  assert.deepEqual(state.calls.find(([name])=>name==='promote')[1],['repo']);
  const promote=state.calls.findIndex(([name])=>name==='promote');
  const materialize=state.calls.findIndex(([name])=>name==='reconcile-runtime');
  const finalRead=state.calls.map(([name])=>name).lastIndexOf('heads');
  assert.ok(promote>=0&&materialize>promote&&finalRead>materialize);
  assert.deepEqual(result,{ok:true,outcome:'converged',repo:'laurajoyhutchins/overcenter',development_revision:DEV,production_revision:DEV,runtime_revision:DEV,development_verification_ref:'github-actions-run:42',runtime_verification_ref:'immutable-runtime:prod:507:manifest',deployment_version:507});
});

test('already-current Git and freshly verified runtime are a production-mutation-free no-op',async()=>{
  let promoted=false;let reconciled=false;
  const {state,ports}=fixture(()=>({promote:async()=>{promoted=true;throw new Error('unexpected');},reconcileRuntime:async()=>{reconciled=true;throw new Error('unexpected');}}));
  state.production=DEV;state.runtime=runtime(DEV,506);
  const result=await reconcileProduction({repo:'laurajoyhutchins/overcenter'},ports);
  assert.equal(result.outcome,'already_converged');assert.equal(promoted,false);assert.equal(reconciled,false);
  assert.equal(state.calls.filter(([name])=>name==='heads').length,2,'fresh runtime evidence is fenced by a final Git reread');
});

test('production-current stale runtime skips promotion and materializes',async()=>{
  let promoted=false;const {state,ports}=fixture(()=>({promote:async()=>{promoted=true;throw new Error('unexpected');}}));
  state.production=DEV;state.runtime=runtime(PROD,505);
  const result=await reconcileProduction({repo:'laurajoyhutchins/overcenter'},ports);
  assert.equal(result.outcome,'converged');assert.equal(promoted,false);
});

test('runtime observation is not attempted against a production branch at another revision',async()=>{
  const {state,ports}=fixture();
  await reconcileProduction({repo:'laurajoyhutchins/overcenter'},ports);
  assert.equal(state.calls.some(([name])=>name==='runtime'),false);
});

test('missing exact development verification fails before mutation',async()=>{
  let promoted=false;let reconciled=false;
  const {ports}=fixture(()=>({verifyDevelopmentRevision:async(_repo,revision)=>({revision,verified:false,verification_ref:''}),promote:async()=>{promoted=true;},reconcileRuntime:async()=>{reconciled=true;}}));
  const error=await failure(()=>reconcileProduction({repo:'laurajoyhutchins/overcenter'},ports));
  assert.equal(error.code,'PRODUCTION_RECONCILIATION_SOURCE_NOT_VERIFIED');assert.equal(error.may_have_mutated,false);assert.equal(promoted,false);assert.equal(reconciled,false);
});

test('post-promotion Git drift fails before runtime reconciliation',async()=>{
  let reconciled=false;const {state,ports}=fixture(stateRef=>({promote:async()=>{stateRef.production=DRIFT;return {ok:true,source_revision:DEV,production_revision:DEV};},reconcileRuntime:async()=>{reconciled=true;}}));
  const error=await failure(()=>reconcileProduction({repo:'laurajoyhutchins/overcenter'},ports));
  assert.equal(error.code,'PRODUCTION_RECONCILIATION_GIT_DRIFT');assert.equal(error.may_have_mutated,true);assert.equal(reconciled,false);assert.equal(state.production,DRIFT);
});

test('indeterminate promotion prevents runtime reconciliation and preserves mutation uncertainty',async()=>{
  let reconciled=false;const {ports}=fixture(()=>({promote:async()=>{throw Object.assign(new Error('transport lost'),{code:'GITHUB_PRODUCTION_PROMOTION_INDETERMINATE',may_have_mutated:true});},reconcileRuntime:async()=>{reconciled=true;}}));
  const error=await failure(()=>reconcileProduction({repo:'laurajoyhutchins/overcenter'},ports));
  assert.equal(error.code,'GITHUB_PRODUCTION_PROMOTION_INDETERMINATE');assert.equal(error.may_have_mutated,true);assert.equal(reconciled,false);
});

test('queued materialization returns pending without claiming runtime convergence',async()=>{
  const {state,ports}=fixture(()=>({reconcileRuntime:async()=>({state:'queued',revision:DEV,run_ref:'github-actions-run:99',mutation_attempted:false})}));
  state.production=DEV;state.runtime=runtime(PROD,505);
  const result=await reconcileProduction({repo:'laurajoyhutchins/overcenter'},ports);
  assert.equal(result.outcome,'materialization_pending');assert.equal(result.materialization_run_ref,'github-actions-run:99');
});

test('indeterminate materialization fails closed',async()=>{
  const {state,ports}=fixture(()=>({reconcileRuntime:async()=>({state:'indeterminate',revision:DEV,run_ref:null,mutation_attempted:true})}));
  state.production=DEV;state.runtime=runtime(PROD,505);
  const error=await failure(()=>reconcileProduction({repo:'laurajoyhutchins/overcenter'},ports));
  assert.equal(error.code,'PRODUCTION_RECONCILIATION_MATERIALIZATION_INDETERMINATE');assert.equal(error.may_have_mutated,true);
});

test('materialization evidence for another revision fails closed',async()=>{
  const {state,ports}=fixture(()=>({reconcileRuntime:async()=>({state:'succeeded',revision:DRIFT,verification_ref:'github-actions-run:507',deployment_version:507,mutation_attempted:true})}));
  state.production=DEV;state.runtime=runtime(PROD,505);
  const error=await failure(()=>reconcileProduction({repo:'laurajoyhutchins/overcenter'},ports));
  assert.equal(error.code,'PRODUCTION_RECONCILIATION_RUNTIME_MISMATCH');
});

test('Git drift after materialization prevents convergence success',async()=>{
  const {state,ports}=fixture(stateRef=>({reconcileRuntime:async()=>{stateRef.development=DRIFT;return {state:'succeeded',revision:DEV,verification_ref:'github-actions-run:507',deployment_version:507,mutation_attempted:true};}}));
  state.production=DEV;state.runtime=runtime(PROD,505);
  const error=await failure(()=>reconcileProduction({repo:'laurajoyhutchins/overcenter'},ports));
  assert.equal(error.code,'PRODUCTION_RECONCILIATION_FINAL_DRIFT');assert.equal(error.may_have_mutated,true);
});

test('caller mechanical coordinates are rejected',async()=>{
  const {ports}=fixture();const error=await failure(()=>reconcileProduction({repo:'laurajoyhutchins/overcenter',candidate_sha:DEV},ports));
  assert.equal(error.code,'PRODUCTION_RECONCILIATION_REQUEST_INVALID');assert.deepEqual(error.details.unsupported_fields,['candidate_sha']);
});