import { createSkillExecutionService, projectSkillState, resolveWorkerSkillPolicy } from 'lib/skill-execution.js';

function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
async function run(name, fn) { try { await fn(); return { name, ok:true }; } catch (error) { return { name, ok:false, error:String(error?.message || error) }; } }
async function expectCode(fn, code) { try { await fn(); } catch (error) { if (error?.code === code) return error; throw new Error(`expected ${code}, got ${error?.code}: ${error?.message}`); } throw new Error(`expected ${code}, got success`); }

function memoryStore(worker = 'Repository Implementation') {
  const run = { run_id:'run-skills', worker, status:'active', skill_policy:resolveWorkerSkillPolicy(worker) };
  const activations = new Map();
  let sequence = 0;
  return {
    run,
    activations,
    async getRun(runId) { return runId === run.run_id ? { ...run } : null; },
    async getActivation(runId, skillName) { return [...activations.values()].find((item)=>item.run_id===runId&&item.skill_name===skillName) || null; },
    async getActivationById(id) { return activations.get(id) || null; },
    async insertActivation(value) {
      const existing = [...activations.values()].find((item)=>item.run_id===value.run_id&&item.skill_name===value.skill_name);
      if (existing) return existing;
      const row = { activation_id:`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`, status:'active', evidence:[], created_at:'2026-08-22T20:00:00.000Z', completed_at:null, completion_sha256:null, ...value };
      activations.set(row.activation_id, row);
      return row;
    },
    async completeActivation(id, status, evidence, completionSha) {
      const row = activations.get(id);
      if (!row || row.status !== 'active') return null;
      Object.assign(row, { status, evidence, completion_sha256:completionSha, completed_at:'2026-08-22T20:05:00.000Z' });
      return row;
    },
    async listActivations(runId) { return [...activations.values()].filter((item)=>item.run_id===runId); },
  };
}

export async function runSkillExecutionTests() {
  const results = [];

  results.push(await run('implementation worker policy is server-owned and pins required and available skill revisions', async()=>{
    const policy = resolveWorkerSkillPolicy('Repository Implementation');
    assert(policy.source==='server'&&policy.catalog_revision==='worker-skills-v1','server policy identity changed');
    const required=policy.required.find((entry)=>entry.name==='verification-before-completion');
    assert(required?.required_before==='work.complete'&&required?.revision&&required?.reference,'required verification skill is not pinned');
    assert(policy.available.some((entry)=>entry.name==='systematic-debugging'&&entry.revision&&entry.reference),'available debugging skill is not pinned');
  }));

  results.push(await run('non-implementation worker gets an explicit empty policy', async()=>{
    const policy = resolveWorkerSkillPolicy('Portfolio Dispatcher');
    assert(policy.required.length===0&&policy.available.length===0&&policy.forbidden.length===0,'dispatcher unexpectedly acquired reasoning procedures');
  }));

  results.push(await run('permitted skill activation is durable and idempotent', async()=>{
    const store=memoryStore();const service=createSkillExecutionService({store});
    const first=await service.activate({run_id:'run-skills',skill:'systematic-debugging',reason:'tests failed'});
    const replay=await service.activate({run_id:'run-skills',skill:'systematic-debugging',reason:'different caller prose'});
    assert(first.activation_id===replay.activation_id&&replay.idempotent_replay===true,'activation replay created duplicate skill state');
    assert(first.revision==='superpowers-systematic-debugging-v1','activation did not pin the run policy revision');
  }));

  results.push(await run('unknown skill activation fails closed', async()=>{
    const service=createSkillExecutionService({store:memoryStore()});
    await expectCode(()=>service.activate({run_id:'run-skills',skill:'arbitrary-new-procedure'}),'SKILL_NOT_PERMITTED');
  }));

  results.push(await run('skill completion is idempotent and conflicting replay fails closed', async()=>{
    const store=memoryStore();const service=createSkillExecutionService({store});
    const activation=await service.activate({run_id:'run-skills',skill:'verification-before-completion'});
    const input={activation_id:activation.activation_id,outcome:'completed',evidence:[{kind:'test_run',ref:'regression-1'}]};
    const first=await service.complete(input);const replay=await service.complete(input);
    assert(first.status==='completed'&&replay.idempotent_replay===true,'completion replay was not idempotent');
    await expectCode(()=>service.complete({...input,evidence:[{kind:'test_run',ref:'different'}]}),'IDEMPOTENCY_CONFLICT');
  }));

  results.push(await run('run skill state exposes remaining required before completion and clears it after completion', async()=>{
    const store=memoryStore();const service=createSkillExecutionService({store});
    const before=await service.state({run_id:'run-skills'});
    assert(before.remaining_required?.[0]?.name==='verification-before-completion','required skill was not projected as remaining');
    const activation=await service.activate({run_id:'run-skills',skill:'verification-before-completion'});
    await service.complete({activation_id:activation.activation_id,outcome:'completed',evidence:[]});
    const after=await service.state({run_id:'run-skills'});
    assert(after.remaining_required.length===0&&after.completed.length===1,'completed required skill did not satisfy run policy');
  }));

  results.push(await run('historical run without stored policy never acquires a retroactive requirement', async()=>{
    const state=projectSkillState({run_id:'historical',worker:'Repository Implementation',status:'finished'},[]);
    assert(state.policy.source==='historical_unknown'&&state.remaining_required.length===0,'historical run acquired a new completion gate');
  }));

  return { ok:results.every((result)=>result.ok), passed:results.filter((result)=>result.ok).length, failed:results.filter((result)=>!result.ok).length, tests:results };
}