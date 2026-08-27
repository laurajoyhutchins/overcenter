import { createProjectTransitionLeaseService } from './project-transition-leases.js';
import { PRODUCTIVE_STAGES } from './work-lifecycle.js';

function assert(value, message) { if (!value) throw new Error(message); }
function expectCode(fn, code) { return Promise.resolve().then(fn).then(()=>{ throw new Error(`expected ${code}`); }, error=>{ if (error?.code !== code) throw error; return error; }); }
function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable:true, satisfied:stageIndex < index }]));
}

function fixture() {
  let now = Date.parse('2026-08-27T13:00:00Z');
  const runs = new Map([['run-1',{ run_id:'run-1', status:'active', deadline_at:'2026-08-27T14:00:00Z' }],['run-2',{ run_id:'run-2', status:'active', deadline_at:'2026-08-27T14:00:00Z' }]]);
  const leases = new Map();
  const slots = new Map();
  const store = {
    async getRun(id){ return runs.get(id)||null; },
    async getLease(id){ return leases.get(id)||null; },
    async getSlot(key){ return slots.get(key)||null; },
    async insertLease(row){ leases.set(row.lease_id,{...row}); return leases.get(row.lease_id); },
    async insertSlot(row){ if (slots.has(row.slot_key)) { const e=new Error('occupied'); e.code='UNIQUE_VIOLATION'; throw e; } slots.set(row.slot_key,{...row}); return slots.get(row.slot_key); },
    async updateLease(id, patch){ const row={...leases.get(id),...patch}; leases.set(id,row); return row; },
    async deleteSlot(key,id){ if (slots.get(key)?.lease_id===id) slots.delete(key); },
  };
  const graph = { schema:'project-graph-authority-v1', project_ref:'github:laurajoyhutchins/overcenter', authority:{ definition:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'1'.repeat(40), derivation:'overcenter-project-graph-v1' }, observations:[] }, nodes:[{ id:'transition-a', priority:1, requires:[], lifecycle:{ current_stage:'ENABLE', responsibilities:responsibilitiesFor('ENABLE') }, executor:{kind:'agent',role:'engineering',skill:'implementation'}, phase_bindings:{} }], horizons:[] };
  let currentGraph=graph;
  const service=createProjectTransitionLeaseService({ store, readProjectGraph:async()=>currentGraph, now:()=>new Date(now).toISOString(), uuid:()=>`00000000-0000-4000-8000-${String(leases.size+1).padStart(12,'0')}` });
  return { service, store, setGraph(value){currentGraph=value;}, advance(ms){now+=ms;}, graph };
}

export async function runProjectTransitionLeaseTests(){
  const tests=[]; async function test(name,fn){ try{await fn();tests.push({name,ok:true});}catch(error){tests.push({name,ok:false,error:String(error?.message||error)});} }
  await test('acquires one exact READY project transition with non-secret lease reference',async()=>{ const f=fixture(); const r=await f.service.acquire({run_id:'run-1',project_ref:'github:laurajoyhutchins/overcenter',transition_id:'transition-a',lease_seconds:600,idempotency_key:'a'}); assert(r.ok&&r.lease_ref&&!('lease_token' in r),'lease reference contract failed'); assert(r.authority.repository==='laurajoyhutchins/overcenter'&&r.authority.revision==='1'.repeat(40),'authority coordinate missing'); });
  await test('competing acquisition of same transition revision is rejected',async()=>{ const f=fixture(); await f.service.acquire({run_id:'run-1',project_ref:'github:laurajoyhutchins/overcenter',transition_id:'transition-a',lease_seconds:600,idempotency_key:'a'}); await expectCode(()=>f.service.acquire({run_id:'run-2',project_ref:'github:laurajoyhutchins/overcenter',transition_id:'transition-a',lease_seconds:600,idempotency_key:'b'}),'PROJECT_TRANSITION_ALREADY_LEASED'); });
  await test('non-READY transition is rejected before lease creation',async()=>{ const f=fixture(); f.setGraph({...f.graph,nodes:[{...f.graph.nodes[0],lifecycle:{current_stage:'EXECUTE',condition:'HOLD',responsibilities:responsibilitiesFor('COMMIT')}}]}); await expectCode(()=>f.service.acquire({run_id:'run-1',project_ref:'github:laurajoyhutchins/overcenter',transition_id:'transition-a',lease_seconds:600,idempotency_key:'a'}),'PROJECT_TRANSITION_NOT_READY'); assert(f.store.getLease('anything') instanceof Promise,'store shape'); });
  await test('settlement is deterministic and stale authority cannot be reused',async()=>{ const f=fixture(); const a=await f.service.acquire({run_id:'run-1',project_ref:'github:laurajoyhutchins/overcenter',transition_id:'transition-a',lease_seconds:600,idempotency_key:'a'}); const s=await f.service.settle({lease_ref:a.lease_ref,run_id:'run-1',disposition:'completed',idempotency_key:'s'}); assert(s.status==='settled'&&s.disposition==='completed','settlement failed'); await expectCode(()=>f.service.settle({lease_ref:a.lease_ref,run_id:'run-1',disposition:'blocked',idempotency_key:'other'}),'PROJECT_TRANSITION_LEASE_ALREADY_SETTLED'); });
  await test('authority revision change invalidates an active lease',async()=>{ const f=fixture(); const a=await f.service.acquire({run_id:'run-1',project_ref:'github:laurajoyhutchins/overcenter',transition_id:'transition-a',lease_seconds:600,idempotency_key:'a'}); f.setGraph({...f.graph,authority:{...f.graph.authority,definition:{...f.graph.authority.definition,revision:'2'.repeat(40)}}}); await expectCode(()=>f.service.require({lease_ref:a.lease_ref,run_id:'run-1',repository:'laurajoyhutchins/overcenter',transition_id:'transition-a'}),'PROJECT_TRANSITION_AUTHORITY_STALE'); });
  return {ok:tests.every(x=>x.ok),passed:tests.filter(x=>x.ok).length,failed:tests.filter(x=>!x.ok).length,tests};
}