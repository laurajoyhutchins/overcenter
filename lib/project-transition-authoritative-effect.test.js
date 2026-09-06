import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTransitionAuthoritativeEffectConfirmationFor } from 'lib/project-transition-authoritative-effect.js';

const SHA='a'.repeat(40);
const MERGE='b'.repeat(40);
const AUTHORITY_REVISION='c'.repeat(40);
const authority={subject:'project_transition',run_id:'run-1',project_ref:'github:owner/repo',transition_id:'t1',repository:'owner/repo',authority:{revision:AUTHORITY_REVISION}};
const workspace={repository:'owner/repo',branch:'work/t1',authority_revision:AUTHORITY_REVISION};
const request={run_id:'run-1',target:{project_ref:'github:owner/repo',horizon:{kind:'transition',ref:'t1'}},execution_result:{disposition:'completed',evidence:[{kind:'verified_candidate',ref:`github:owner/repo@${SHA}`}]}};

function service(overrides={}){
  let pulls=overrides.pulls || [];
  return projectTransitionAuthoritativeEffectConfirmationFor({
    async readLeaseRef(){return 'lease-1';},
    executionAuthority:{async require(){return authority;}},
    async deriveWorkspace(){return workspace;},
    async resolveBranchRoles(){return {development_branch:'dev'};},
    async readPullRequests(){return pulls;},
    async readBranchHead(){return overrides.developmentHead || AUTHORITY_REVISION;},
    async compareCommits(){return {status:'identical',behind_by:0};},
    async integrateCandidate(input){
      if(overrides.integrateCandidate) await overrides.integrateCandidate(input);
      pulls=[{number:17,state:'closed',merged_at:'2026-09-06T02:00:00Z',merge_commit_sha:MERGE,head:{sha:SHA,ref:'work/t1'},base:{ref:'dev'}}];
      return {ok:true,outcome:'merged',pull_request:17,merge_commit_sha:MERGE};
    },
  });
}

test('verified candidate drives deterministic exact-head integration then confirms authoritative readback',async()=>{
  let integration=null;
  const result=await service({developmentHead:AUTHORITY_REVISION,integrateCandidate:async(input)=>{integration=input;}}).confirm(request);
  assert.equal(integration.repository,'owner/repo');
  assert.equal(integration.workspace_branch,'work/t1');
  assert.equal(integration.development_branch,'dev');
  assert.equal(integration.expected_base,AUTHORITY_REVISION);
  assert.equal(integration.expected_head,SHA);
  assert.equal(result.confirmed,true);
  assert.ok(result.evidence.some(item=>item.kind==='authoritative_effect'));
  assert.ok(result.evidence.some(item=>item.kind==='authority_readback'));
});

test('moved development authority never integrates an exact candidate verified against the old base',async()=>{
  let integrations=0;
  const moved='d'.repeat(40);
  const result=await service({developmentHead:moved,integrateCandidate:async()=>{integrations+=1;}}).confirm(request);
  assert.equal(integrations,0);
  assert.equal(result.confirmed,false);
  assert.equal(result.reason,'authoritative_base_moved');
  assert.equal(result.observed_development_head,moved);
});

test('already merged exact candidate remains a read-only idempotent confirmation',async()=>{
  let integrations=0;
  const mergedPull={number:17,state:'closed',merged_at:'2026-09-06T02:00:00Z',merge_commit_sha:MERGE,head:{sha:SHA,ref:'work/t1'},base:{ref:'dev'}};
  const result=await service({pulls:[mergedPull],developmentHead:MERGE,integrateCandidate:async()=>{integrations+=1;}}).confirm(request);
  assert.equal(integrations,0);
  assert.equal(result.confirmed,true);
});