import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCheckoutSourceAdapter, createHatchableRuntimeAdapter, normalizeMcpToolResult, verificationInputFromEnv } from './exact-revision-v8-verification.mjs';
import { normalizeRemoteMcpToolResult } from './exact-revision-v8-verification-http.mjs';

const revision='a'.repeat(40);

test('source bytes come from the exact Git object and repository package metadata is not Hatchable runtime source', async()=>{
  const calls=[];
  const blobs=new Map([
    ['api/a.js','exact-blob\n'],
    ['lib/b.js','export const b=2;'],
    ['hatchable.toml','[mcp]\nenabled = true\n'],
    ['package.json','{"name":"overcenter"}\n'],
    ['docs/ignore.md','ignore'],
    ['public/.overcenter/source-materialization.json','{}'],
  ]);
  const source=createCheckoutSourceAdapter({runGit:async args=>{
    calls.push(args);
    if(args[0]==='rev-parse') return revision+'\n';
    if(args[0]==='ls-tree') return [...blobs.keys()].join('\0')+'\0';
    if(args[0]==='cat-file') return Buffer.from(blobs.get(args[2].slice(41)),'utf8');
    throw new Error('unexpected git call');
  }});
  const observed=await source.observe({repository:'laurajoyhutchins/overcenter',revision});
  assert.deepEqual(observed.files.map(f=>f.path),['api/a.js','hatchable.toml','lib/b.js']);
  assert.equal(observed.files[0].content,'exact-blob\n');
  assert.equal(observed.files[0].sha256,createHash('sha256').update('exact-blob\n').digest('hex'));
  assert.deepEqual(calls.map(args=>args[0]),['rev-parse','ls-tree','cat-file','cat-file','cat-file']);
});

test('source adapter reports mismatched HEAD without reading blobs', async()=>{
  const calls=[];
  const source=createCheckoutSourceAdapter({runGit:async args=>{calls.push(args);return 'b'.repeat(40)+'\n';}});
  const observed=await source.observe({repository:'laurajoyhutchins/overcenter',revision});
  assert.equal(observed.revision,'b'.repeat(40));
  assert.deepEqual(calls.map(args=>args[0]),['rev-parse']);
});

test('Hatchable adapter observes package metadata only in mutable draft cleanup, never immutable runtime evidence', async()=>{
  const calls=[];
  const responses=[
    {current_version:5},{files:[
      {path:'api/a.js',hash:'a'.repeat(64)},
      {path:'package.json',hash:'c'.repeat(64)},
      {path:'AGENTS.md',virtual:true,hash:null},
    ]},
    {ok:true},{ok:true},{ok:true},{current_version:5},{version:6},{current_version:6},
    {version:6,file_manifest:[
      {path:'api/a.js',hash:'b'.repeat(64)},
      {path:'package.json',hash:'d'.repeat(64)},
    ]},
    {status:200,body:{ok:true,schema:'regression-verification-v1',passed:683,failed:0}},
  ];
  const runtime=createHatchableRuntimeAdapter({callTool:async(name,args)=>{calls.push([name,args]);return responses.shift();}});
  assert.deepEqual(await runtime.inspect('verify'),{
    project:'verify',
    version:5,
    files:[
      {path:'api/a.js',sha256:'a'.repeat(64)},
      {path:'package.json',sha256:'c'.repeat(64)},
    ],
  });
  await runtime.reconcile({
    project:'verify',
    revision:'c'.repeat(40),
    expected_version:5,
    writes:[{path:'api/a.js',content:'new'}],
    deletes:['lib/stale.js','package.json'],
  });
  assert.deepEqual(await runtime.deploy({project:'verify',revision:'c'.repeat(40),expected_version:5}),{version:6});
  assert.deepEqual(await runtime.inspectDeployment({project:'verify',version:6}),{
    version:6,
    files:[{path:'api/a.js',sha256:'b'.repeat(64)}],
  });
  assert.equal((await runtime.runRegressions({project:'verify'})).failed,0);
  assert.deepEqual(calls.map(([name])=>name),[
    'get_project','list_files','write_files','delete_file','delete_file','get_project','deploy','get_project','get_deployment','run_function',
  ]);
});

test('production reachability evidence traverses real orchestration API entrypoints and terminalizes its probe', async()=>{
  const calls=[];
  const repository='laurajoyhutchins/overcenter';
  const graphRevision='c'.repeat(40);
  const responses=[
    {status:200,body:{ok:true,schema:'orchestration-run-v1'}},
    {status:200,body:{
      ok:true,
      schema:'project-horizon-evaluation-v1',
      horizon:{authority:{kind:'github',repository,revision:graphRevision,derivation:'overcenter-project-graph-v1'}},
      target:{project_ref:`github:${repository}`,horizon:{kind:'transition',ref:'require-production-reachability'}},
    }},
    {status:200,body:{ok:true}},
  ];
  const runtime=createHatchableRuntimeAdapter({callTool:async(name,args)=>{calls.push([name,args]);return responses.shift();}});
  const evidence=await runtime.runProductionReachability({project:'verify',repository,revision});
  assert.deepEqual(calls.map(([,args])=>args.path),[
    '/api/orchestration/start',
    '/api/orchestration/horizon-resolve',
    '/api/orchestration/finish',
  ]);
  assert.equal(calls[0][1].body.target.project_ref,`github:${repository}`);
  assert.equal(calls[0][1].body.target.horizon.ref,'require-production-reachability');
  assert.equal(calls[2][1].body.disposition,'clean-stop');
  assert.deepEqual(evidence,{
    schema:'production-reachability-evidence-v1',
    entrypoint:'/api/orchestration/horizon-resolve',
    runtime_project:'verify',
    runtime_revision:revision,
    graph_authority:{kind:'github',repository,revision:graphRevision,derivation:'overcenter-project-graph-v1'},
    target:{project_ref:`github:${repository}`,horizon:{kind:'transition',ref:'require-production-reachability'}},
  });
});

test('production reachability can stop at the isolated runtime external GitHub configuration boundary', async()=>{
  const calls=[];
  const repository='laurajoyhutchins/overcenter';
  const responses=[
    {status:200,body:{ok:true,schema:'orchestration-run-v1'}},
    {status:500,body:{
      ok:false,
      error:'ORCHESTRATION_HORIZON_ERROR',
      message:"gateway internal/config/get 412: Configuration value 'GITHUB_APP_ID' is declared as required but not set.",
    }},
    {status:200,body:{ok:true}},
  ];
  const runtime=createHatchableRuntimeAdapter({callTool:async(name,args)=>{calls.push([name,args]);return responses.shift();}});
  const evidence=await runtime.runProductionReachability({project:'verify',repository,revision});
  assert.deepEqual(calls.map(([,args])=>args.path),[
    '/api/orchestration/start',
    '/api/orchestration/horizon-resolve',
    '/api/orchestration/finish',
  ]);
  assert.deepEqual(evidence.boundary,{
    kind:'external_dependency',
    dependency:'github_app',
    configuration_key:'GITHUB_APP_ID',
  });
  assert.equal('graph_authority' in evidence,false);
  assert.deepEqual(evidence.target,{project_ref:`github:${repository}`,horizon:{kind:'transition',ref:'require-production-reachability'}});
});

test('Hatchable adapter rejects a verifier project that changed before deployment', async()=>{
  const runtime=createHatchableRuntimeAdapter({callTool:async()=>({current_version:8})});
  await assert.rejects(runtime.deploy({project:'verify',revision:'c'.repeat(40),expected_version:7}),e=>e?.code==='VERIFICATION_RUNTIME_VERSION_MISMATCH');
});

test('normalizes structured and JSON-text MCP results and rejects tool errors',()=>{
  assert.deepEqual(normalizeMcpToolResult({structuredContent:{current_version:7},content:[]}),{current_version:7});
  const remoteStructured={structuredContent:{text:JSON.stringify({files:[{path:'api/a.js'}]})},content:[]};
  assert.deepEqual(normalizeRemoteMcpToolResult(remoteStructured),{files:[{path:'api/a.js'}]});
  const wrapped={content:[{type:'text',text:JSON.stringify({text:JSON.stringify({files:[{path:'api/a.js'}]})})}]};
  assert.deepEqual(normalizeMcpToolResult(wrapped),{files:[{path:'api/a.js'}]});
  assert.throws(()=>normalizeMcpToolResult({isError:true,content:[{type:'text',text:'boom'}]}),e=>e?.code==='HATCHABLE_MCP_TOOL_ERROR');
});

test('environment configuration keeps credential and runtime coordinates explicit',()=>{
  const configured=verificationInputFromEnv({GITHUB_REPOSITORY:'laurajoyhutchins/overcenter',GITHUB_SHA:revision,OVERCENTER_HATCHABLE_VERIFICATION_PROJECT:'verify',OVERCENTER_HATCHABLE_PRODUCTION_PROJECT:'prod',HATCHABLE_TOKEN:'secret'});
  assert.equal(configured.token,'secret');
  assert.equal(configured.input.verification_project,'verify');
  assert.equal(configured.input.production_project,'prod');
  assert.throws(()=>verificationInputFromEnv({}),e=>e?.code==='HATCHABLE_TOKEN_REQUIRED');
});