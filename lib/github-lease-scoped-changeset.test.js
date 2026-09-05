import { applyGithubLeaseScopedChangeset, resolveGithubLeaseScopedChangeset } from 'lib/github-lease-scoped-changeset.js';
import { CANONICAL_COMMANDS } from 'lib/canonical-commands.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';
import { validateSemanticWorkerCommand } from 'lib/worker-transport.js';
import { createOrchestrationAdvanceService } from 'lib/orchestration-advance.js';
import { applyGithubLeaseScopedTextReplacements } from 'lib/github-worker-mutations.js';

const LEASE_REF='33333333-3333-4333-8333-333333333333';
const REPO='laurajoyhutchins/overcenter';
const PROJECT_REF='github:laurajoyhutchins/overcenter';
const EXECUTION_INTENT=Object.freeze({
  schema:'project-execution-intent-v1',
  desired_outcome:'Verify the authority-bound agent handoff.',
  acceptance_evidence:Object.freeze([Object.freeze({kind:'verification',requirement:'Evidence must prove the intended agent handoff behavior.'})]),
  source_ref:'github:issue:420',
});
const AUTHORITY=Object.freeze({
  subject:'project_transition', lease_id:LEASE_REF, lease_ref:LEASE_REF, run_id:'run-1', authority_epoch:1,
  repository:REPO, project_ref:PROJECT_REF, transition_id:'ignore-stale-historical-project-transition-leases',
  authority:{kind:'github',repository:REPO,revision:'1'.repeat(40),derivation:'overcenter-project-graph-v1'},
  graph_fingerprint:'a'.repeat(64), transition_definition_fingerprint:'b'.repeat(64),
});

function input(overrides={}) { return { lease_ref:LEASE_REF, changes:[{path:'lib/orchestration-diagnose.js',operation:'update',content:'fixture\n'}], commit_message:'fix: classify current and historical transition leases', ...overrides }; }
function check(condition,message){if(!condition)throw new Error(message);}
async function run(name,fn){try{await fn();return{name,ok:true};}catch(error){return{name,ok:false,error:String(error?.message||error)};}}
function withGithub(branchHead=null){
  return async(_request,callback)=>callback({
    async getBranch(){return branchHead===null?null:{sha:branchHead};},
  });
}

function agentGraph(){
  const responsibilities=Object.fromEntries(['ENABLE','ACQUIRE','EXECUTE','COMMIT','CONFIRM'].map(stage=>[stage,{applicable:true,satisfied:false}]));
  return {
    schema:'project-graph-authority-v1',
    project_ref:PROJECT_REF,
    authority:{definition:{kind:'github',repository:REPO,revision:'1'.repeat(40),derivation:'overcenter-project-graph-v1'},observations:[]},
    nodes:[{
      id:'ignore-stale-historical-project-transition-leases',priority:10,requires:[],unmet_requirements:[],
      lifecycle:{current_stage:'ENABLE',condition:'NOMINAL',responsibilities},
      executor:{kind:'agent',role:'implementation',skill:'test-driven-development'},execution_intent:EXECUTION_INTENT,phase_bindings:{},
    }],
    horizons:[],
  };
}

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
  results.push(await run('lease-scoped application revalidates the lease inside the existing changeset authority boundary',async()=>{
    const calls=[];
    const result=await applyGithubLeaseScopedChangeset(input(),{
      executionAuthority:{async require(request){calls.push(request);return AUTHORITY;}},
      readBranch:async()=>null,
      withGithub:withGithub(null),
      applyChangeset:async(request,options)=>{
        const evidence=await options.executionAuthority.require({repository:request.repo});
        return {ok:true,repo:request.repo,branch:request.branch,idempotency_key:request.idempotency_key,execution_authority:evidence};
      },
    });
    check(result.ok===true&&/^work\//.test(result.branch),'resolved request did not reach the existing changeset boundary');
    check(calls.length===2&&calls[0].lease_ref===LEASE_REF&&calls[1].lease_ref===LEASE_REF,'lease was not revalidated at mutation authority boundary');
    check(result.execution_authority.github_workspace?.branch===result.branch,'workspace evidence was not preserved through mutation authority');
  }));
  results.push(await run('authority drift between workspace read and mutation boundary fails closed',async()=>{
    let calls=0;let error=null;
    const changed={...AUTHORITY,authority:{...AUTHORITY.authority,revision:'2'.repeat(40)}};
    try{
      await applyGithubLeaseScopedChangeset(input(),{
        executionAuthority:{async require(){calls+=1;return calls===1?AUTHORITY:changed;}},
        readBranch:async()=>null,
        withGithub:withGithub(null),
        applyChangeset:async(request,options)=>{await options.executionAuthority.require({repository:request.repo});return{ok:true};},
      });
    }catch(observed){error=observed;}
    check(error?.code==='EXECUTION_AUTHORITY_STALE','authority revision drift did not stop before mutation');
  }));
  results.push(await run('new workspace branch appearing after lease-scope read fails before low-level preflight',async()=>{
    let error=null;
    try{
      await applyGithubLeaseScopedChangeset(input(),{
        executionAuthority:{async require(){return AUTHORITY;}},
        readBranch:async()=>null,
        withGithub:withGithub('2'.repeat(40)),
        applyChangeset:async(request,options)=>{
          await options.github.getBranch(request.repo,request.branch,{phase:'preflight.branch_read'});
          return{ok:true};
        },
      });
    }catch(observed){error=observed;}
    check(error?.code==='HEAD_MISMATCH','new managed workspace silently adopted a branch that appeared after lease-scope resolution');
  }));
  results.push(await run('worker command discovery exposes only lease-scoped GitHub mutation inputs',async()=>{
    check(CANONICAL_COMMANDS.includes('github.apply_changeset'),'github.apply_changeset is missing from canonical commands');
    check(CANONICAL_COMMANDS.includes('github.apply_text_replacements'),'github.apply_text_replacements is missing from canonical commands');
    for(const command of ['github.apply_changeset','github.apply_text_replacements']){
      const descriptor=semanticCommandDescriptor(command);
      check(descriptor.exposure.worker===true,`${command} is not worker-exposed`);
      check(descriptor.required_fields.includes('lease_ref')&&descriptor.required_fields.includes('commit_message'),`${command} does not advertise lease-scoped authority`);
      for(const forbidden of ['repo','branch','base_ref','base_sha','expected_head','idempotency_key','lease_token']){
        check(!descriptor.semantic_fields.includes(forbidden),`${command} advertises caller-owned ${forbidden}`);
      }
    }
    validateSemanticWorkerCommand('github.apply_changeset',input());
    validateSemanticWorkerCommand('github.apply_text_replacements',{lease_ref:LEASE_REF,replacements:[{path:'README.md',old:'before',new_text:'after'}],commit_message:'fix: replace text'});
  }));
  results.push(await run('agent execution packet names the lease-authorized mutation commands',async()=>{
    const service=createOrchestrationAdvanceService({
      store:{async getRun(){return{run_id:'run-1',status:'active',target:{project_ref:PROJECT_REF,horizon:{kind:'transition',ref:'ignore-stale-historical-project-transition-leases'}}};}},
      readProjectGraph:async()=>agentGraph(),
      projectTransitions:{async acquire(){return AUTHORITY;},async settle(){throw new Error('agent handoff must not settle');}},
    });
    const result=await service.advance({run_id:'run-1'});
    check(result.outcome==='AGENT_EXECUTION_REQUIRED','agent execution handoff was not produced');
    check(JSON.stringify(result.lease_authorized_mutations)===JSON.stringify(['github.apply_changeset','github.apply_text_replacements']),'agent handoff did not name its lease-authorized mutation surface');
  }));
  results.push(await run('lease-scoped text replacements bind source read to the same workspace observation as mutation',async()=>{
    const branchReads=[];const readRefs=[];const applied=[];
    const result=await applyGithubLeaseScopedTextReplacements({
      lease_ref:LEASE_REF,
      replacements:[{path:'README.md',old:'before',new_text:'after',expected_count:1}],
      commit_message:'fix: replace text',
    },{
      executionAuthority:{async require(){return AUTHORITY;}},
      readBranch:async()=>{branchReads.push(true);return null;},
      readTextAtRef:async({ref})=>{readRefs.push(ref);return'before\n';},
      withGithub:withGithub(null),
      applyChangeset:async(request,options)=>{
        applied.push(request);
        await options.executionAuthority.require({repository:request.repo});
        await options.github.getBranch(request.repo,request.branch,{phase:'preflight.branch_read'});
        return{ok:true,branch:request.branch,execution_authority:await options.executionAuthority.require({repository:request.repo})};
      },
    });
    check(result.ok===true,'lease-scoped text replacement did not apply');
    check(readRefs.length===1&&readRefs[0]==='1'.repeat(40),'new workspace text was not read from exact authority revision');
    check(applied.length===1&&applied[0].changes[0].content==='after\n','computed replacement did not reach existing changeset engine');
    check(branchReads.length===2,'text replacement did not re-observe workspace before mutation');
  }));
  results.push(await run('text replacement refuses stale content when workspace advances after exact read',async()=>{
    let reads=0;let mutations=0;let error=null;
    try{
      await applyGithubLeaseScopedTextReplacements({
        lease_ref:LEASE_REF,
        replacements:[{path:'README.md',old:'before',new_text:'after'}],
        commit_message:'fix: replace text',
      },{
        executionAuthority:{async require(){return AUTHORITY;}},
        readBranch:async()=>{reads+=1;return reads===1?null:'2'.repeat(40);},
        readTextAtRef:async()=> 'before\n',
        withGithub:withGithub('2'.repeat(40)),
        applyChangeset:async()=>{mutations+=1;return{ok:true};},
      });
    }catch(observed){error=observed;}
    check(error?.code==='HEAD_MISMATCH','workspace movement after text read did not fail with HEAD_MISMATCH');
    check(mutations===0,'stale text reached mutation boundary');
  }));
  const failed=results.filter(result=>!result.ok);return{ok:failed.length===0,passed:results.length-failed.length,failed:failed.length,results};
}
