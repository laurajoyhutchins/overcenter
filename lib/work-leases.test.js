import { createWorkLeaseService } from './work-leases.js';

const STATES = [
  { id: 's-backlog', name: 'Backlog', type: 'backlog' },
  { id: 's-done', name: 'Done', type: 'completed' },
  { id: 's-todo', name: 'Todo', type: 'unstarted' },
  { id: 's-progress', name: 'In Progress', type: 'started' },
];
const LABELS = [
  { id: 'l-repo', name: 'lane:repo-implementation' },
  { id: 'l-source', name: 'lane:source-implementation' },
  { id: 'l-verify', name: 'lane:verification' },
  { id: 'l-integrate', name: 'lane:integration' },
];

function lane(issue) { return issue.labels.find(x => x.name.startsWith('lane:')); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function semantic(issue) {
  return JSON.stringify({
    title: issue.title,
    description: issue.description || '',
    priority: issue.priority ?? null,
    archivedAt: issue.archivedAt || null,
    project: issue.project || null,
    state: issue.state || null,
    labels: issue.labels || [],
    relations: issue.relations || [],
  });
}
function issue(ref = 'LJH-T1', state = 'Todo', laneName = 'lane:repo-implementation') {
  return {
    id: `uuid-${ref}`, identifier: ref, title: 'Disposable lease test',
    description: 'Repository: `owner/repo`\n\nAuthority: GitHub #1\n\nExact coordinate: test\n\nAcceptance: deterministic\n\nOwner impact: none.',
    priority: 2, updatedAt: 'rev-1', archivedAt: null, project: { id: 'p', name: 'Portfolio Orchestration' },
    state: clone(STATES.find(x => x.name === state)), labels: [clone(LABELS.find(x => x.name === laneName))],
    relations: [], teamStates: clone(STATES), teamLabels: clone(LABELS),
  };
}

class FakeAuthority {
  constructor(items) { this.items = new Map(items.map(x => [x.identifier, clone(x)])); this.rev = 1; this.failNext = false; this.ambiguousAfterNext = false; this.commentBeforeNextTransition = false; this.materialBeforeNextTransition = null; this.commentWrites = 0; this.history = []; }
  async getIssue(ref) { const v = this.items.get(ref); if (!v) { const e = new Error('missing'); e.code = 'WORK_NOT_FOUND'; throw e; } return clone(v); }
  async transition({ issue: base, expectedRevision, expectedState, expectedLane, targetState, targetLane, description = null }) {
    if (this.failNext) { this.failNext = false; const e = new Error('forced'); e.code = 'LINEAR_UPSTREAM_GRAPHQL'; throw e; }
    const current = this.items.get(base.identifier);
    if (this.commentBeforeNextTransition) { this.commentBeforeNextTransition = false; this.commentWrites += 1; current.updatedAt = `rev-${++this.rev}`; }
    if (this.materialBeforeNextTransition) { const patch = this.materialBeforeNextTransition; this.materialBeforeNextTransition = null; this.humanEdit(base.identifier, patch); }
    if (semantic(current) !== semantic(base) || current.state.name !== expectedState || lane(current)?.name !== expectedLane) {
      const e = new Error('changed'); e.code = 'WORK_STATE_CHANGED'; e.details = { actual_state: current.state.name, actual_lane: lane(current)?.name, expected_revision: expectedRevision, actual_revision: current.updatedAt }; throw e;
    }
    current.state = clone(STATES.find(x => x.name === targetState));
    current.labels = [...current.labels.filter(x => !x.name.startsWith('lane:')), clone(LABELS.find(x => x.name === targetLane))];
    if (description !== null) current.description = description;
    current.updatedAt = `rev-${++this.rev}`;
    this.history.push({ ref: current.identifier, state: targetState, lane: targetLane });
    if (this.ambiguousAfterNext) { this.ambiguousAfterNext = false; const e = new Error('ambiguous after mutation'); e.code = 'LINEAR_UPSTREAM_HTTP'; throw e; }
    return clone(current);
  }
  humanEdit(ref, patch = {}) {
    const current = this.items.get(ref);
    if (patch.state) current.state = clone(STATES.find(x => x.name === patch.state));
    if (patch.lane) current.labels = [clone(LABELS.find(x => x.name === patch.lane))];
    if (patch.description) current.description = patch.description;
    if (patch.priority !== undefined) current.priority = patch.priority;
    current.updatedAt = `rev-${++this.rev}`;
  }
  addComment(ref) {
    const current = this.items.get(ref);
    this.commentWrites += 1;
    current.updatedAt = `rev-${++this.rev}`;
  }
  appendExecutionEvidence(ref, text = 'Execution evidence: verified head abc123') {
    const current = this.items.get(ref);
    current.description = `${current.description}\n\n${text}`;
    current.updatedAt = `rev-${++this.rev}`;
  }
  addMetadataLabel(ref, name = 'bookkeeping:evidence-recorded') {
    const current = this.items.get(ref);
    current.labels.push({ id: `meta-${name}`, name });
    current.updatedAt = `rev-${++this.rev}`;
  }
}

class MemoryStore {
  constructor() { this.leases = new Map(); this.claims = new Map(); this.tokens = new Map(); this.slots = new Map(); }
  slotKey(w,g) { return `${w}|${g}`; }
  async getClaimByIdempotency(k) { return this.claims.get(k) || null; }
  async getLeaseById(id) { return this.leases.get(id) || null; }
  async getLeaseByTokenHash(h) { return this.tokens.get(h) || null; }
  async getSlot(w,g) { return this.slots.get(this.slotKey(w,g)) || null; }
  async insertLease(l) { if (this.claims.has(l.claim_idempotency_key)) return { inserted:false, lease:this.claims.get(l.claim_idempotency_key) }; const v={...clone(l)}; this.leases.set(v.lease_id,v); this.claims.set(v.claim_idempotency_key,v); this.tokens.set(v.token_hash,v); return {inserted:true,lease:v}; }
  async tryAcquireSlot(w,g,id,expires) { const k=this.slotKey(w,g); if(this.slots.has(k)) return false; this.slots.set(k,{work_ref:w,gate:g,lease_id:id,expires_at:expires}); return true; }
  async activateLease(id,rev,receipt) { const l=this.leases.get(id); l.status='active'; l.active_revision=rev; l.claim_receipt=clone(receipt); return l; }
  async rejectLease(id,code,details) { const l=this.leases.get(id); l.status='rejected'; l.rejection_code=code; l.rejection_details=clone(details); return l; }
  async markExpired(id,recon) { const l=this.leases.get(id); if(l.status!=='settled') l.status='expired'; l.reconciliation=clone(recon); return l; }
  async invalidateLease(id,recon) { const l=this.leases.get(id); if(l.status!=='settled') l.status='invalidated'; l.reconciliation=clone(recon); return l; }
  async releaseSlot(w,g,id) { const k=this.slotKey(w,g); const s=this.slots.get(k); if(s?.lease_id===id){this.slots.delete(k);return 1;} return 0; }
  async beginSettlement(id,idem,hash,plan) { const l=this.leases.get(id); if(l.status==='active'&&!l.settle_idempotency_key){l.status='settling';l.settle_idempotency_key=idem;l.settle_request_hash=hash;l.settle_plan=clone(plan);return l;} if(l.settle_idempotency_key===idem&&l.settle_request_hash===hash)return l; const e=new Error('consumed');e.code='LEASE_ALREADY_SETTLED';throw e; }
  async completeSettlement(id,idem,hash,plan,receipt,settledAt) { const l=this.leases.get(id); l.status='settled';l.settle_idempotency_key=idem;l.settle_request_hash=hash;l.settle_plan=clone(plan);l.settle_receipt=clone(receipt);l.settled_at=settledAt;return l; }
}

function harness({ state='Todo', laneName='lane:repo-implementation', ref='LJH-T1' }={}) {
  let ms = Date.parse('2026-08-16T20:00:00Z'); let token = 0;
  const authority = new FakeAuthority([issue(ref,state,laneName)]); const store = new MemoryStore();
  const service = createWorkLeaseService({store,authoritative:authority,now:()=>new Date(ms).toISOString(),tokenFactory:()=>`test-token-${++token}`});
  return {service,store,authority,advance:s=>{ms+=s*1000;},ref};
}
function claimReq(ref='LJH-T1', idem='claim-1', extra={}) { return {work_ref:ref,run_id:'test-run',expected_state:'Todo',expected_lane:'lane:repo-implementation',lease_seconds:1800,idempotency_key:idem,...extra}; }
function settleReq(token, disposition='requeue', idem='settle-1', extra={}) { return {lease_token:token,disposition,idempotency_key:idem,evidence:[],...extra}; }
async function expectCode(fn, code) { try { await fn(); } catch(e) { if(e.code===code) return e; throw new Error(`expected ${code}, got ${e.code}: ${e.message}`); } throw new Error(`expected ${code}, got success`); }
function assert(v,msg){ if(!v) throw new Error(msg); }

export async function runWorkLeaseTests() {
  const tests=[]; async function test(name,fn){try{await fn();tests.push({name,ok:true});}catch(e){tests.push({name,ok:false,error:String(e.message||e)});}}

  await test('1 successful claim of executable Todo', async()=>{const h=harness();const r=await h.service.claim(claimReq());assert(r.ok&&r.previous_state==='Todo','claim failed');});
  await test('2 active lifecycle transition during claim', async()=>{const h=harness();await h.service.claim(claimReq());assert((await h.authority.getIssue(h.ref)).state.name==='In Progress','not active');});
  await test('3 second claimant rejected while lease active', async()=>{const h=harness();await h.service.claim(claimReq());await expectCode(()=>h.service.claim(claimReq(h.ref,'claim-2')), 'ALREADY_CLAIMED');});
  await test('4 expired lease can be reclaimed from truthfully observed In Progress', async()=>{const h=harness();await h.service.claim(claimReq());h.advance(1801);const r=await h.service.claim(claimReq(h.ref,'claim-2',{expected_state:'In Progress'}));assert(r.ok&&r.lease_id,'reclaim failed');});
  await test('5 stale lease cannot settle after successor claim', async()=>{const h=harness();const a=await h.service.claim(claimReq());h.advance(1801);await h.service.claim(claimReq(h.ref,'claim-2',{expected_state:'In Progress'}));await expectCode(()=>h.service.settle(settleReq(a.lease_token)), 'LEASE_EXPIRED');});
  await test('6 claim idempotent replay', async()=>{const h=harness();const a=await h.service.claim(claimReq());const b=await h.service.claim(claimReq());assert(a.lease_id===b.lease_id&&a.lease_token===b.lease_token&&b.idempotent_replay,'not replayed');});
  await test('7 state precondition mismatch', async()=>{const h=harness();await expectCode(()=>h.service.claim(claimReq(h.ref,'c',{expected_state:'Backlog'})),'STATE_MISMATCH');});
  await test('8 lane precondition mismatch', async()=>{const h=harness();await expectCode(()=>h.service.claim(claimReq(h.ref,'c',{expected_lane:'lane:verification'})),'LANE_MISMATCH');});
  await test('9 Linear transition failure means claim does not report success', async()=>{const h=harness();h.authority.failNext=true;await expectCode(()=>h.service.claim(claimReq()),'LINEAR_TRANSITION_FAILED');assert(!(await h.store.getSlot(h.ref,'lane:repo-implementation')),'slot stranded');});
  await test('10 completed settlement', async()=>{const h=harness();const a=await h.service.claim(claimReq());const r=await h.service.settle(settleReq(a.lease_token,'completed'));assert(r.current_state==='Todo'&&r.current_lane==='lane:verification','wrong successor');});
  await test('11 requeue settlement', async()=>{const h=harness();const a=await h.service.claim(claimReq());const r=await h.service.settle(settleReq(a.lease_token));assert(r.current_state==='Todo'&&r.current_lane==='lane:repo-implementation','wrong requeue');});
  await test('12 blocked settlement', async()=>{const h=harness();const a=await h.service.claim(claimReq());const r=await h.service.settle(settleReq(a.lease_token,'blocked','s',{reason:'Durable upstream source unavailable',promotion_condition:'Authoritative source becomes retrievable'}));const i=await h.authority.getIssue(h.ref);assert(r.current_state==='Backlog'&&i.description.includes('Execution blocker'),'block not recorded');});
  await test('13 settlement idempotent replay', async()=>{const h=harness();const a=await h.service.claim(claimReq());const x=await h.service.settle(settleReq(a.lease_token));const y=await h.service.settle(settleReq(a.lease_token));assert(x.lease_id===y.lease_id&&y.idempotent_replay,'settle replay failed');});
  await test('14 settlement with expired token rejected', async()=>{const h=harness();const a=await h.service.claim(claimReq());h.advance(1801);await expectCode(()=>h.service.settle(settleReq(a.lease_token)),'LEASE_EXPIRED');});
  await test('15 consumed token rejects different settlement identity', async()=>{const h=harness();const a=await h.service.claim(claimReq());await h.service.settle(settleReq(a.lease_token));await expectCode(()=>h.service.settle(settleReq(a.lease_token,'requeue','settle-2')),'LEASE_ALREADY_SETTLED');});
  await test('16 authoritative issue changed after claim', async()=>{const h=harness();const a=await h.service.claim(claimReq());h.authority.humanEdit(h.ref,{description:'human edit'});await expectCode(()=>h.service.settle(settleReq(a.lease_token)),'WORK_STATE_CHANGED');});
  await test('17 human lifecycle change after claim is not overwritten', async()=>{const h=harness();const a=await h.service.claim(claimReq());h.authority.humanEdit(h.ref,{state:'Done'});await expectCode(()=>h.service.settle(settleReq(a.lease_token)),'WORK_STATE_CHANGED');assert((await h.authority.getIssue(h.ref)).state.name==='Done','human change overwritten');});
  await test('18 stale In Progress recovery after crashed worker', async()=>{const h=harness();await h.service.claim(claimReq());h.advance(1801);await h.service.claim(claimReq(h.ref,'claim-2',{expected_state:'In Progress'}));const seq=h.authority.history.map(x=>x.state).join('>');assert(seq.includes('In Progress>Todo>In Progress'),`bad recovery ${seq}`);});
  await test('19 concurrent claim race permits exactly one winner', async()=>{const h=harness();const results=await Promise.allSettled([h.service.claim(claimReq(h.ref,'race-a')),h.service.claim(claimReq(h.ref,'race-b'))]);assert(results.filter(x=>x.status==='fulfilled').length===1,'race had wrong winners');});
  await test('20 no claim/comment marker writes are needed in Linear', async()=>{const h=harness();const a=await h.service.claim(claimReq());await h.service.settle(settleReq(a.lease_token));assert(h.authority.commentWrites===0,'comment marker written');});
  await test('21 completed verification may route to validated remediation lane', async()=>{const h=harness({laneName:'lane:verification'});const a=await h.service.claim(claimReq(h.ref,'claim-v',{expected_lane:'lane:verification'}));const r=await h.service.settle(settleReq(a.lease_token,'completed','settle-v',{next_state:'Todo',next_lane:'lane:repo-implementation'}));assert(r.current_state==='Todo'&&r.current_lane==='lane:repo-implementation','verification remediation route failed');});
  await test('22 invalid completed successor is rejected', async()=>{const h=harness();const a=await h.service.claim(claimReq());await expectCode(()=>h.service.settle(settleReq(a.lease_token,'completed','settle-bad',{next_state:'Done',next_lane:'lane:integration'})),'INVALID_SUCCESSOR');});
  await test('23 ambiguous claim transition recovers only by exact idempotent replay', async()=>{const h=harness();h.authority.ambiguousAfterNext=true;await expectCode(()=>h.service.claim(claimReq()),'CLAIM_INDETERMINATE');const r=await h.service.claim(claimReq());assert(r.ok&&r.idempotent_replay&&r.current_state==='In Progress','ambiguous claim did not recover');assert(h.authority.history.length===1,'claim transition repeated');});
  await test('24 settlement receipt retains bounded evidence refs', async()=>{const h=harness();const a=await h.service.claim(claimReq());await h.service.settle(settleReq(a.lease_token,'requeue','settle-evidence',{evidence:[{kind:'git_head',ref:'abc123'}]}));const l=await h.store.getLeaseById(a.lease_id);assert(l.settle_plan.evidence?.[0]?.ref==='abc123','evidence ref not retained');});
  await test('25 stale recovery rejects a precondition that was not actually observed', async()=>{const h=harness();await h.service.claim(claimReq());h.advance(1801);await expectCode(()=>h.service.claim(claimReq(h.ref,'claim-wrong',{expected_state:'Todo'})),'STATE_MISMATCH');assert((await h.authority.getIssue(h.ref)).state.name==='In Progress','mismatched probe mutated authoritative state');const r=await h.service.claim(claimReq(h.ref,'claim-correct',{expected_state:'In Progress'}));assert(r.ok&&r.previous_state==='Todo','truthful recovery precondition did not reclaim');});
  await test('26 orphaned In Progress without a lease is recovered and claimed', async()=>{const h=harness({state:'In Progress'});const r=await h.service.claim(claimReq(h.ref,'orphan-claim',{expected_state:'In Progress'}));assert(r.ok&&r.previous_state==='Todo'&&r.current_state==='In Progress','orphan recovery failed');const seq=h.authority.history.map(x=>x.state).join('>');assert(seq==='Todo>In Progress',`bad orphan recovery ${seq}`);});
  await test('27 orphan recovery preserves optimistic state fencing', async()=>{const h=harness({state:'In Progress'});await expectCode(()=>h.service.claim(claimReq(h.ref,'orphan-wrong',{expected_state:'Todo'})),'STATE_MISMATCH');assert((await h.authority.getIssue(h.ref)).state.name==='In Progress','wrong precondition mutated orphan');});
  await test('28 expired slot with missing lease record recovers safely', async()=>{const h=harness({state:'In Progress'});h.store.slots.set(`${h.ref}|lane:repo-implementation`,{work_ref:h.ref,gate:'lane:repo-implementation',lease_id:'missing-lease',expires_at:'2026-08-16T19:00:00.000Z'});const r=await h.service.claim(claimReq(h.ref,'missing-lease-recovery',{expected_state:'In Progress'}));assert(r.ok&&r.previous_state==='Todo'&&r.current_state==='In Progress','missing-lease recovery failed');assert((await h.store.getSlot(h.ref,'lane:repo-implementation'))?.lease_id===r.lease_id,'successor slot not authoritative');});
  await test('29 Linear comment revision after claim does not invalidate settlement', async()=>{const h=harness();const a=await h.service.claim(claimReq());h.authority.addComment(h.ref);const r=await h.service.settle(settleReq(a.lease_token,'completed','comment-safe-settle'));assert(r.current_lane==='lane:verification','comment-only revision blocked settlement');});
  await test('30 Linear comment arriving during settlement transition is tolerated', async()=>{const h=harness();const a=await h.service.claim(claimReq());h.authority.commentBeforeNextTransition=true;const r=await h.service.settle(settleReq(a.lease_token,'completed','comment-race-settle'));assert(r.current_lane==='lane:verification'&&h.authority.commentWrites===1,'comment race blocked transition');});
  await test('31 priority edit after claim still invalidates settlement', async()=>{const h=harness();const a=await h.service.claim(claimReq());h.authority.humanEdit(h.ref,{priority:1});await expectCode(()=>h.service.settle(settleReq(a.lease_token,'completed','priority-edit-settle')),'WORK_STATE_CHANGED');});
  await test('32 comment-only revision does not prevent expired lease recovery', async()=>{const h=harness();await h.service.claim(claimReq());h.authority.addComment(h.ref);h.advance(1801);const r=await h.service.claim(claimReq(h.ref,'comment-recovery',{expected_state:'In Progress'}));assert(r.ok&&r.current_state==='In Progress','comment-only revision stranded expired lease');});
  await test('33 pre-upgrade claim snapshots remain settle-compatible', async()=>{const h=harness();const a=await h.service.claim(claimReq());const lease=await h.store.getLeaseById(a.lease_id);delete lease.claim_receipt.execution_projection;delete lease.claim_receipt.execution_fingerprint;h.authority.addComment(h.ref);const r=await h.service.settle(settleReq(a.lease_token,'completed','legacy-snapshot-settle'));assert(r.current_lane==='lane:verification','legacy snapshot was invalidated by comment revision');});
  await test('34 completion evidence appended after claim does not strand settlement', async()=>{const h=harness();const a=await h.service.claim(claimReq());const claimRev=a.authoritative_revision;h.authority.appendExecutionEvidence(h.ref);const before=await h.authority.getIssue(h.ref);assert(before.updatedAt!==claimRev,'evidence did not advance broad revision');const r=await h.service.settle(settleReq(a.lease_token,'completed','evidence-safe-settle'));assert(r.current_lane==='lane:verification','completion evidence blocked settlement');assert(r.claim_authoritative_revision===claimRev,'claim revision evidence missing');assert(r.execution_precondition_verified===true,'semantic precondition not recorded');});
  await test('35 unrelated metadata label after claim does not strand settlement', async()=>{const h=harness();const a=await h.service.claim(claimReq());h.authority.addMetadataLabel(h.ref);const r=await h.service.settle(settleReq(a.lease_token,'completed','metadata-safe-settle'));assert(r.current_lane==='lane:verification','metadata label blocked settlement');});
  await test('36 source authority change remains material settlement rejection', async()=>{const h=harness();const a=await h.service.claim(claimReq());const i=await h.authority.getIssue(h.ref);h.authority.humanEdit(h.ref,{description:i.description.replace('Authority: GitHub #1','Authority: GitHub #2')});const e=await expectCode(()=>h.service.settle(settleReq(a.lease_token,'completed','authority-change-settle')),'WORK_STATE_CHANGED');assert(e.details?.changed_fields?.includes('authority'),'authority mismatch not explained');const lease=await h.store.getLeaseById(a.lease_id);assert(lease.status==='invalidated','rejected settlement left lease owning');assert(!(await h.store.getSlot(h.ref,'lane:repo-implementation')),'rejected settlement left active slot');});
  await test('37 material lane race during settlement terminates lease instead of stranding settling', async()=>{const h=harness();const a=await h.service.claim(claimReq());h.authority.materialBeforeNextTransition={lane:'lane:verification'};await expectCode(()=>h.service.settle(settleReq(a.lease_token,'completed','lane-race-settle')),'WORK_STATE_CHANGED');const lease=await h.store.getLeaseById(a.lease_id);assert(lease.status==='invalidated','transition-time rejection left lease settling');assert(!(await h.store.getSlot(h.ref,'lane:repo-implementation')),'transition-time rejection left slot active');});
  await test('38 upstream failure before settlement mutation preserves retryable settling state', async()=>{const h=harness();const a=await h.service.claim(claimReq());h.authority.failNext=true;await expectCode(()=>h.service.settle(settleReq(a.lease_token,'completed','settle-retry')),'LINEAR_UPSTREAM_GRAPHQL');const mid=await h.store.getLeaseById(a.lease_id);assert(mid.status==='settling','indeterminate pre-mutation failure released ownership');const r=await h.service.settle(settleReq(a.lease_token,'completed','settle-retry'));assert(r.current_lane==='lane:verification','retry did not resolve settlement');});
  await test('39 ambiguous failure after settlement mutation resolves by idempotent reread', async()=>{const h=harness();const a=await h.service.claim(claimReq());h.authority.ambiguousAfterNext=true;await expectCode(()=>h.service.settle(settleReq(a.lease_token,'completed','settle-ambiguous')),'LINEAR_UPSTREAM_HTTP');const transitions=h.authority.history.length;const r=await h.service.settle(settleReq(a.lease_token,'completed','settle-ambiguous'));assert(r.idempotent_replay&&r.current_lane==='lane:verification','ambiguous mutation did not reconcile');assert(h.authority.history.length===transitions,'retry repeated lifecycle transition');});
  await test('40 new claims persist deterministic execution projection evidence', async()=>{const h=harness();const a=await h.service.claim(claimReq());const lease=await h.store.getLeaseById(a.lease_id);assert(lease.claim_receipt.execution_projection?.work_ref===h.ref,'execution projection not persisted');assert(typeof lease.claim_receipt.execution_fingerprint==='string'&&lease.claim_receipt.execution_fingerprint.length===64,'execution fingerprint not persisted');});

  return {ok:tests.every(t=>t.ok),passed:tests.filter(t=>t.ok).length,failed:tests.filter(t=>!t.ok).length,tests};
}