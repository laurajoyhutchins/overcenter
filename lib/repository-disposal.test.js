import { createRepositoryDisposalService } from './repository-disposal.js';

function assert(value, message) { if (!value) throw new Error(message); }

function harness() {
  const state = {
    lifecycle: { repository:'owner/dead', disposition:'ACTIVE', ordinary_work_enabled:true, successor_repository:null, github_archived:true },
    work: [
      { id:'linear-1', identifier:'LJH-1', repository:'owner/dead', archivedAt:null, state:{name:'Todo',type:'unstarted'}, labels:['lane:repo-implementation'] },
      { id:'linear-2', identifier:'LJH-2', repository:'owner/dead', archivedAt:null, state:{name:'Canceled',type:'canceled'}, labels:['lane:verification'] },
    ],
    invalidated: [], retired: [],
  };
  const lifecycle = {
    async dispose(input) {
      state.lifecycle = { ...state.lifecycle, disposition:input.disposition||'ARCHIVED', ordinary_work_enabled:false, successor_repository:input.successor_repository||null, changed:state.lifecycle.disposition!==(input.disposition||'ARCHIVED') };
      return { ...state.lifecycle };
    },
    async verify() { return { ok:true, ...state.lifecycle, health_classification:'disposed_as_intended', checks:{ github_archived:true, linear_projection:'disabled', scheduled_workers:'none', fast_forward_eligible:false, issue_discovery_eligible:false, successor_recorded:Boolean(state.lifecycle.successor_repository) } }; },
  };
  const workSurface = {
    async listRepositoryWork() { return state.work.filter(item=>!item.archivedAt).map(item=>({...item})); },
    async retire(item) { const row=state.work.find(x=>x.id===item.id); if(!row.archivedAt){row.state={name:'Canceled',type:'canceled'};row.archivedAt='2026-08-22T16:40:00.000Z';state.retired.push(row.identifier);} return {identifier:row.identifier,archived:true}; },
  };
  const leases = {
    async invalidateWorkRefs(refs, metadata) { state.invalidated.push(...refs); return refs.map(work_ref=>({work_ref,status:'invalidated',reason:metadata.reason})); },
    async activeForWorkRefs() { return []; },
  };
  return { state, service:createRepositoryDisposalService({lifecycle,workSurface,leases,now:()=> '2026-08-22T16:40:00.000Z'}) };
}

export async function runRepositoryDisposalTests() {
  const tests=[];
  async function test(name,fn){try{await fn();tests.push({name,ok:true});}catch(error){tests.push({name,ok:false,error:String(error?.message||error)});}}

  await test('dispose blocks lifecycle before retiring stale execution projections', async()=>{
    const h=harness();
    const result=await h.service.dispose({repository:'owner/dead',disposition:'ARCHIVED',reason:'retired'});
    assert(result.ok===true,'dispose did not succeed');
    assert(h.state.lifecycle.ordinary_work_enabled===false,'lifecycle was not disposed');
    assert(h.state.invalidated.length===2,'stale work refs were not fenced from active leases');
    assert(h.state.retired.length===2,'stale Linear execution projections were not retired');
    assert(result.verification.checks.executable_portfolio_work==='none','verification still reports executable work');
  });

  await test('dispose is idempotent and preserves historical projections as archived evidence', async()=>{
    const h=harness();
    await h.service.dispose({repository:'owner/dead',disposition:'ARCHIVED',reason:'retired'});
    const again=await h.service.dispose({repository:'owner/dead',disposition:'ARCHIVED',reason:'retired'});
    assert(again.retired_linear_refs.length===0,'repeat disposal re-mutated historical projections');
    assert(h.state.work.every(item=>item.archivedAt),'historical Linear evidence was deleted instead of archived');
  });

  await test('retirement packets expose no compatibility maintenance surface', async()=>{
    const h=harness();
    const result=await h.service.dispose({repository:'owner/dead',disposition:'ARCHIVED',reason:'retired'});
    assert(result.verification.ordinary_work_enabled===false,'disposed repository revived ordinary work');
    assert(!('compatibility_work_allowed' in result.verification),'retired compatibility work leaked into verification packet');
    assert(!('remaining_external_dependency' in result.verification),'retired compatibility dependency leaked into verification packet');
    assert(!('compatibility_bound' in result),'retired compatibility bound leaked into disposal result');
  });

  await test('SUPERSEDED disposal records successor without making old repo executable', async()=>{
    const h=harness();
    const result=await h.service.dispose({repository:'owner/dead',disposition:'SUPERSEDED',successor_repository:'owner/new',reason:'responsibility moved'});
    assert(result.verification.successor==='owner/new'&&result.verification.fast_forward_eligible===false,'successor routing changed old-repo eligibility');
  });

  return {ok:tests.every(t=>t.ok),passed:tests.filter(t=>t.ok).length,failed:tests.filter(t=>!t.ok).length,tests};
}