import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./node-lib-alias-loader.mjs', import.meta.url);
const { applyGithubChangeset, GitHubChangesetError } = await import('../lib/github-apply-changeset.js');

const sha = (n) => Number(n).toString(16).padStart(40, '0');
class Receipts {
  constructor(){ this.rows=new Map(); }
  key(n){ return `${n.repo}#${n.idempotency_key}`; }
  async claim(n,digest,token){ const key=this.key(n); const existing=this.rows.get(key); if(existing){ if(existing.request_sha256!==digest)return{kind:'conflict',row:existing}; if(['succeeded','prepared'].includes(existing.state))return{kind:'existing',row:existing}; return{kind:'in_progress',row:existing}; } const row={repo:n.repo,idempotency_key:n.idempotency_key,request_sha256:digest,state:'processing',attempt_token:token,branch:n.branch}; this.rows.set(key,row); return{kind:'claimed',row}; }
  async findSucceededByCommit(repo,branch,commitSha){ return [...this.rows.values()].find(row=>row.repo===repo&&row.branch===branch&&row.commit_sha===commitSha&&row.state==='succeeded')||null; }
  async savePlan(n,t,p){ Object.assign(this.rows.get(this.key(n)),{base_sha:p.baseSha,old_head:p.oldHead,created_branch:p.createdBranch,precondition_verified:p.preconditionVerified,changed_paths:p.changedPaths}); }
  async heartbeat(){ return true; }
  async saveTree(n,t,tree){ this.rows.get(this.key(n)).tree_sha=tree; }
  async saveCommit(n,t,commit){ Object.assign(this.rows.get(this.key(n)),{commit_sha:commit,state:'prepared'}); }
  async succeed(n,t,receipt){ const row=this.rows.get(this.key(n)); Object.assign(row,{state:'succeeded',receipt}); return true; }
  async abandon(n){ this.rows.delete(this.key(n)); }
}
class Github {
  constructor(){ this.main=sha(1); this.seq=10; this.forceUpdates=[]; this.failUpdate=null; const tree=sha(2); this.trees=new Map([[tree,new Map([['f.txt',{path:'f.txt',mode:'100644',type:'blob',sha:sha(3),content:'base\n'}]])]]); this.commits=new Map([[this.main,{sha:this.main,tree_sha:tree,message:'base',parents:[]}]]); this.branches=new Map([['main',this.main],['work/existing',this.main]]); }
  async resolveCommit(repo,selector){ const id=this.branches.get(selector)||selector; const c=this.commits.get(id); return{sha:c.sha,tree_sha:c.tree_sha}; }
  async getBranch(repo,branch){ return this.branches.has(branch)?{sha:this.branches.get(branch)}:null; }
  async getCommit(repo,id){ return{...this.commits.get(id)}; }
  async getPathEntries(repo,tree,paths){ const entries=this.trees.get(tree)||new Map(); return new Map(paths.map(path=>[path,entries.get(path)||null])); }
  async createTree(repo,base,entries){ const next=new Map(this.trees.get(base)||[]); for(const entry of entries){ if(entry.sha===null)next.delete(entry.path); else next.set(entry.path,{...entry,sha:sha(++this.seq)}); } const id=sha(++this.seq); this.trees.set(id,next); return id; }
  async createCommit(repo,{message,treeSha,parentSha}){ const id=sha(++this.seq); this.commits.set(id,{sha:id,tree_sha:treeSha,message,parents:[parentSha]}); return id; }
  async createBranch(repo,branch,id){ this.branches.set(branch,id); }
  async updateBranch(repo,branch,id,options={}){ this.forceUpdates.push(options.force===true); if(this.failUpdate){ const failure=this.failUpdate; this.failUpdate=null; if(failure.applied)this.branches.set(branch,id); throw new GitHubChangesetError('GITHUB_TRANSPORT_ERROR','simulated uncertain ref update',{phase:'mutation.ref_update',may_have_mutated:true},502); } this.branches.set(branch,id); }
}
const request=(key,message,content,coalesce=false)=>({repo:'laurajoyhutchins/overcenter',base_ref:'main',branch:'work/existing',expected_head:null,changes:[{path:'f.txt',operation:'update',content}],commit_message:message,idempotency_key:key,...(coalesce?{coalesce_mechanical_head:true}:{})});
const authorityFor=(leaseId='lease-1')=>({require:async()=>({subject:'project_transition',lease_id:leaseId})});
const idFactory=()=>{let n=0;return()=>`00000000-0000-0000-0000-${String(++n).padStart(12,'0')}`;};
async function firstMechanical(github,receipts){ return applyGithubChangeset(request('one','style: first cleanup','first\n'),{github,receipts,executionAuthority:authorityFor(),idFactory:idFactory()}); }

test('mechanical follow-up advertises executable recovery without a second mutation',async()=>{
  const github=new Github(); const receipts=new Receipts(); const first=await firstMechanical(github,receipts);
  const blocked=await applyGithubChangeset({...request('two','style: final newline','second\n'),expected_head:first.new_head},{github,receipts,executionAuthority:authorityFor(),idFactory:idFactory()});
  assert.equal(blocked.error,'MECHANICAL_CHANGESET_MUST_COALESCE');
  assert.deepEqual(blocked.recovery_operation,{command:'github.apply_changeset',set:{coalesce_mechanical_head:true}});
  assert.equal(github.branches.get('work/existing'),first.new_head);
});

test('same-lease recovery replaces the exact mechanical head and replays idempotently',async()=>{
  const github=new Github(); const receipts=new Receipts(); const first=await firstMechanical(github,receipts);
  const input={...request('two','style: final newline','second\n',true),expected_head:first.new_head};
  const combined=await applyGithubChangeset(input,{github,receipts,executionAuthority:authorityFor(),idFactory:idFactory()});
  assert.equal(combined.ok,true); assert.equal(github.forceUpdates.at(-1),true); assert.deepEqual(github.commits.get(combined.new_head).parents,[github.main]);
  const replay=await applyGithubChangeset(input,{github,receipts,executionAuthority:authorityFor(),idFactory:idFactory()});
  assert.equal(replay.ok,true); assert.equal(replay.idempotent_replay,true);
});

test('coalescing fails closed when the current mechanical head belongs to another lease',async()=>{
  const github=new Github(); const receipts=new Receipts(); const first=await firstMechanical(github,receipts);
  const result=await applyGithubChangeset({...request('two','style: final newline','second\n',true),expected_head:first.new_head},{github,receipts,executionAuthority:authorityFor('lease-2'),idFactory:idFactory()});
  assert.equal(result.error,'MECHANICAL_CHANGESET_COALESCE_AUTHORITY_MISMATCH'); assert.equal(github.branches.get('work/existing'),first.new_head); assert.equal(github.forceUpdates.length,1);
});

test('coalescing rejects a non-mechanical current head before mutation',async()=>{
  const github=new Github(); const receipts=new Receipts(); const first=await firstMechanical(github,receipts); github.commits.get(first.new_head).message='feat: substantive head';
  const result=await applyGithubChangeset({...request('two','style: final newline','second\n',true),expected_head:first.new_head},{github,receipts,executionAuthority:authorityFor(),idFactory:idFactory()});
  assert.equal(result.error,'MECHANICAL_CHANGESET_COALESCE_PRECONDITION_FAILED'); assert.equal(github.branches.get('work/existing'),first.new_head); assert.equal(github.forceUpdates.length,1);
});

test('stale exact head fails before coalescing mutation',async()=>{
  const github=new Github(); const receipts=new Receipts(); const first=await firstMechanical(github,receipts); const moved=sha(99); github.commits.set(moved,{sha:moved,tree_sha:github.commits.get(first.new_head).tree_sha,message:'style: concurrent cleanup',parents:[first.new_head]}); github.branches.set('work/existing',moved);
  const result=await applyGithubChangeset({...request('two','style: final newline','second\n',true),expected_head:first.new_head},{github,receipts,executionAuthority:authorityFor(),idFactory:idFactory()});
  assert.equal(result.error,'HEAD_MISMATCH'); assert.equal(github.forceUpdates.length,1);
});

test('uncertain forced ref update converges by authoritative readback without replaying mutation',async()=>{
  const github=new Github(); const receipts=new Receipts(); const first=await firstMechanical(github,receipts); github.failUpdate={applied:true};
  const result=await applyGithubChangeset({...request('two','style: final newline','second\n',true),expected_head:first.new_head},{github,receipts,executionAuthority:authorityFor(),idFactory:idFactory()});
  assert.equal(result.ok,true); assert.equal(github.forceUpdates.filter(Boolean).length,1); assert.notEqual(github.branches.get('work/existing'),first.new_head);
});