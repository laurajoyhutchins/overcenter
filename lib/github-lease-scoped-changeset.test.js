import { resolveGithubLeaseScopedChangeset } from 'lib/github-lease-scoped-changeset.js';

const LEASE_REF='33333333-3333-4333-8333-333333333333';
const REPO='laurajoyhutchins/overcenter';
const AUTHORITY=Object.freeze({
  subject:'project_transition', lease_id:LEASE_REF, lease_ref:LEASE_REF, run_id:'run-1', authority_epoch:1,
  repository:REPO, project_ref:'github:laurajoyhutchins/overcenter', transition_id:'ignore-stale-historical-project-transition-leases',
  authority:{kind:'github',repository:REPO,revision:'1'.repeat(40),derivation:'overcenter-project-graph-v1'},
  graph_fingerprint:'a'.repeat(64), transition_definition_fingerprint:'b'.repeat(64),
});

function input(overrides={}) { return { lease_ref:LEASE_REF, changes:[{path:'lib/orchestration-diagnose.js',operation:'update',content:'fixture\n'}], commit_message:'fix: classify current and historical transition leases', ...overrides }; }
function check(condition,message){if(!condition)throw new Error(message);}
async function run(name,fn){try{await fn();return{name,ok:true};}catch(error){return{name,ok:false,error:String(error?.message||error)};}}

export async function runGithubLeaseScopedChangesetTests(){
  const results=[];
  results.push(await run('lease-scoped request derives every Git execution coordinate from verified authority',async()=>{
    const authorityCalls=[]; const branchReads=[];
    const result=await resolveGithubLeaseScopedChangeset(input(),{
      executionAuthority:{async require(request){authorityCalls.push(request);return AUTHORITY;}},
      readBranch:async(request)=>{branchReads.push(request);return null;},
    });
    check(JSON.stringify(authorityCalls)===JSON.stringify([{lease_ref:LEASE_REF}]),'authority resolver received caller-selected scope');
    check(result.request.repo===REPO,'repository was not derived');
    check(result.request.base_sha==='1'.repeat(40),'exact authority revision was not used as generation base');
    check(/^work\//.test(result.request.branch),'managed workspace branch was not derived');
    check(result.request.expected_head===null,'new workspace unexpectedly had an expected head');
    check(/^project-transition-changeset-v1:[0-9a-f]{64}$/.test(result.request.idempotency_key),'idempotency was not derived');
    check(result.request.lease_token===undefined,'lease token leaked into resolved request');
    check(branchReads.length===1&&branchReads[0].repo===REPO&&branchReads[0].branch===result.request.branch,'workspace branch was not read exactly once');
    check(result.execution_authority.github_workspace?.workspace_digest,'workspace evidence was omitted from authority');
  }));
  results.push(await run('existing workspace head becomes the exact CAS fence and mutation identity input',async()=>{
    const head='2'.repeat(40);
    const result=await resolveGithubLeaseScopedChangeset(input(),{executionAuthority:{async require(){return AUTHORITY;}},readBranch:async()=>head});
    check(result.request.expected_head===head,'observed workspace head was not preserved as CAS fence');
    const replay=await resolveGithubLeaseScopedChangeset(input(),{executionAuthority:{async require(){return AUTHORITY;}},readBranch:async()=>head});
    const advanced=await resolveGithubLeaseScopedChangeset(input(),{executionAuthority:{async require(){return AUTHORITY;}},readBranch:async()=> '3'.repeat(40)});
    check(result.request.idempotency_key===replay.request.idempotency_key,'exact resolver replay drifted');
    check(result.request.idempotency_key!==advanced.request.idempotency_key,'advanced workspace head reused mutation identity');
  }));
  results.push(await run('lease-scoped mode rejects caller-selected Git coordinates before authority or Git reads',async()=>{
    for(const field of ['repo','branch','base_ref','base_sha','expected_head','idempotency_key','lease_token']){
      let authorityReads=0;let branchReads=0;let error=null;
      try{await resolveGithubLeaseScopedChangeset(input({[field]:field==='expected_head'?'2'.repeat(40):'caller'}),{executionAuthority:{async require(){authorityReads+=1;return AUTHORITY;}},readBranch:async()=>{branchReads+=1;return null;}});}catch(observed){error=observed;}
      check(error?.code==='INVALID_REQUEST',`${field} was not rejected as a mixed authority source`);
      check(authorityReads===0&&branchReads===0,`${field} reached authority/Git dependencies before rejection`);
    }
  }));
  results.push(await run('legacy work leases cannot acquire implicit workspace semantics',async()=>{
    let error=null;
    try{await resolveGithubLeaseScopedChangeset(input(),{executionAuthority:{async require(){return{work_ref:'LJH-1',lease_id:LEASE_REF,run_id:'run-1',gate:'lane:repo-implementation',repository:REPO,execution_fingerprint:'x'};}},readBranch:async()=>null});}catch(observed){error=observed;}
    check(error?.code==='LEASE_SCOPED_CHANGESET_PROJECT_TRANSITION_REQUIRED','legacy work lease gained implicit Git workspace authority');
  }));
  const failed=results.filter(result=>!result.ok);return{ok:failed.length===0,passed:results.length-failed.length,failed:failed.length,results};
}
