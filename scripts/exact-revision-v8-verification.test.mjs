import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyExactRevisionV8 } from './exact-revision-v8-verification.mjs';
import { hatchableMcpTransportConfig } from './exact-revision-v8-verification-http.mjs';

const repository='laurajoyhutchins/overcenter';
const revision='a'.repeat(40);
const verification_project='verification-slot';
const production_project='production-slot';
const input={repository,revision,verification_project,production_project};
const content="export const access = 'public';\n";
const hash=createHash('sha256').update(content).digest('hex');
const runtimeContent=content.replace(/[ \t\r\n\v\f]+$/u,'');
const runtimeHash=createHash('sha256').update(runtimeContent).digest('hex');
const green={ok:true,schema:'regression-verification-v1',passed:683,failed:0};

function adapters(overrides={}) {
  return {
    source:{observe:async()=>({repository,revision,files:[{path:'api/example.js',content,sha256:hash}]})},
    runtime:{
      inspect:async()=>({project:verification_project,version:7,files:[{path:'api/stale.js',sha256:'b'.repeat(64)}]}),
      reconcile:async()=>{}, deploy:async()=>({version:8}),
      inspectDeployment:async()=>({version:8,files:[{path:'api/example.js',sha256:runtimeHash}]}),
      runRegressions:async()=>green,
    },
    ...overrides,
  };
}

test('Hatchable MCP transport uses canonical remote endpoint with bearer auth',()=>{
  const config=hatchableMcpTransportConfig('secret-token');
  assert.equal(config.url,'https://hatchable.com/mcp');
  assert.deepEqual(config.requestInit,{headers:{Authorization:'Bearer secret-token'}});
});

test('returns canonical exact-revision evidence with isolated runtime attribution', async()=>{
  const result=await verifyExactRevisionV8(input,adapters());
  assert.equal(result.schema,'exact-revision-verification-v1');
  assert.equal(result.repository,repository);
  assert.equal(result.revision,revision);
  assert.equal('runtime' in result,false);
  assert.equal(result.regression.schema,'regression-verification-v1');
  assert.equal(result.regression.execution.project,verification_project);
  assert.equal(result.regression.execution.deployment_version,8);
  assert.equal(result.regression.execution.source_normalization,'hatchable-v8-text-v1');
  assert.notEqual(result.regression.execution.source_manifest_sha256,result.regression.execution.runtime_manifest_sha256);
});

test('rejects post-deploy source mismatch', async()=>{
  const base=adapters();
  base.runtime.inspectDeployment=async()=>({version:8,files:[{path:'api/example.js',sha256:'c'.repeat(64)}]});
  await assert.rejects(verifyExactRevisionV8(input,base),e=>e?.code==='SOURCE_MATERIALIZATION_MISMATCH');
});

test('rejects a moving ref before touching the runtime', async()=>{
  let touched=false;
  await assert.rejects(verifyExactRevisionV8({...input,revision:'main'},{source:{observe:async()=>{touched=true;return {}}},runtime:{}}),e=>e?.code==='INVALID_REVISION');
  assert.equal(touched,false);
});

test('rejects a source observation attributed to another revision before execution', async()=>{
  let executed=false;
  const bad=adapters();
  bad.source.observe=async()=>({repository,revision:'d'.repeat(40),files:[]});
  bad.runtime.inspect=async()=>{executed=true;return {version:7,files:[]}};
  await assert.rejects(verifyExactRevisionV8(input,bad),e=>e?.code==='EXACT_REVISION_MISMATCH');
  assert.equal(executed,false);
});

test('rejects a deployment that is not the immediate successor', async()=>{
  const bad=adapters(); bad.runtime.deploy=async()=>({version:9});
  await assert.rejects(verifyExactRevisionV8(input,bad),e=>e?.code==='DEPLOYMENT_VERSION_MISMATCH');
});

test('rejects non-green canonical V8 regressions', async()=>{
  const bad=adapters(); bad.runtime.runRegressions=async()=>({...green,ok:false,passed:682,failed:1});
  await assert.rejects(verifyExactRevisionV8(input,bad),e=>e?.code==='V8_REGRESSION_FAILED');
});

test('refuses a verification project equal to production before source access', async()=>{
  let touched=false;
  await assert.rejects(verifyExactRevisionV8({...input,verification_project:'same',production_project:'same'},{source:{observe:async()=>{touched=true;return {}}},runtime:{}}),e=>e?.code==='VERIFICATION_RUNTIME_NOT_ISOLATED');
  assert.equal(touched,false);
});

test('attributes exact GitHub bytes while verifying Hatchable-stable trailing-whitespace normalization', async()=>{
  const raw='x \n';
  const rawHash=createHash('sha256').update(raw).digest('hex');
  const canonical='x';
  const canonicalHash=createHash('sha256').update(canonical).digest('hex');
  let writes=null;
  const result=await verifyExactRevisionV8(input,{
    source:{observe:async()=>({repository,revision,files:[{path:'lib/example.js',content:raw,sha256:rawHash}]})},
    runtime:{
      inspect:async()=>({project:verification_project,version:7,files:[]}),
      reconcile:async request=>{writes=request.writes;},
      deploy:async()=>({version:8}),
      inspectDeployment:async()=>({version:8,files:[{path:'lib/example.js',sha256:canonicalHash}]}),
      runRegressions:async()=>green,
    },
  });
  assert.deepEqual(writes,[{path:'lib/example.js',content:canonical}]);
  assert.equal(result.regression.execution.source_normalization,'hatchable-v8-text-v1');
  assert.notEqual(result.regression.execution.source_manifest_sha256,result.regression.execution.runtime_manifest_sha256);
});