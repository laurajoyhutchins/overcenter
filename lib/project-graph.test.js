import { evaluateProjectGraph } from './project-graph.js';
import { PRODUCTIVE_STAGES } from './work-lifecycle.js';

function assert(value, message) { if (!value) throw new Error(message); }
function doneResponsibilities() {
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage) => [stage, { applicable:true, satisfied:true }]));
}
function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable:true, satisfied:stageIndex < index }]));
}
function operatorNode(id, overrides = {}) {
  return {
    id,
    priority: 0,
    requires: [],
    lifecycle: { current_stage:'ENABLE', responsibilities:responsibilitiesFor('ENABLE') },
    executor: { kind:'operator', command:'test.noop' },
    ...overrides,
  };
}
function byId(result, id) { return result.nodes.find((node) => node.id === id); }
function expectFailure(fn, message) {
  let failed = false;
  try { fn(); } catch { failed = true; }
  assert(failed, message);
}

export async function runProjectGraphTests() {
  const tests = [];
  async function test(name, fn) { try { await fn(); tests.push({name,ok:true}); } catch (error) { tests.push({name,ok:false,error:String(error?.message||error)}); } }

  await test('completed prerequisite enables dependent node', async()=>{
    const result = evaluateProjectGraph({ nodes:[
      operatorNode('source', { lifecycle:{ current_stage:'CONFIRM', responsibilities:doneResponsibilities() } }),
      operatorNode('build', { requires:['source'] }),
    ] });
    assert(byId(result,'source').state === 'DONE', 'completed prerequisite was not DONE');
    assert(byId(result,'build').state === 'READY', 'dependent node was not READY');
    assert(result.frontier.map((node)=>node.id).join(',') === 'build', 'ready frontier did not contain dependent');
  });

  await test('incomplete prerequisites block with exact sorted unmet ids', async()=>{
    const result = evaluateProjectGraph({ nodes:[
      operatorNode('z-source'),
      operatorNode('a-source'),
      operatorNode('build', { requires:['z-source','a-source'] }),
    ] });
    const build = byId(result,'build');
    assert(build.state === 'WAITING', 'dependent was not waiting');
    assert(JSON.stringify(build.unmet_requirements) === JSON.stringify(['a-source','z-source']), 'unmet requirements were not exact and sorted');
    assert(!result.frontier.some((node)=>node.id==='build'), 'waiting node entered frontier');
  });

  await test('off-nominal node is excluded from ready frontier', async()=>{
    const result = evaluateProjectGraph({ nodes:[operatorNode('repair', {
      lifecycle:{ current_stage:'EXECUTE', condition:'FAULT', responsibilities:responsibilitiesFor('COMMIT') },
    })] });
    assert(byId(result,'repair').state === 'OFF_NOMINAL', 'faulted node state was not off-nominal');
    assert(result.frontier.length === 0, 'off-nominal node entered frontier');
  });

  await test('ready frontier is deterministic by priority then id', async()=>{
    const result = evaluateProjectGraph({ nodes:[
      operatorNode('c', { priority:2 }),
      operatorNode('a', { priority:1 }),
      operatorNode('b', { priority:2 }),
    ] });
    assert(result.frontier.map((node)=>node.id).join(',') === 'b,c,a', 'frontier ordering was not deterministic');
  });

  await test('node evaluation preserves lifecycle command resolution', async()=>{
    const result = evaluateProjectGraph({ nodes:[operatorNode('commit-me', {
      lifecycle:{ current_stage:'EXECUTE', responsibilities:responsibilitiesFor('COMMIT') },
    })] });
    const evaluated = byId(result,'commit-me');
    assert(evaluated.lifecycle.next_stage === 'COMMIT', 'next lifecycle stage was not preserved');
    assert(evaluated.lifecycle.command === 'work.commit', 'lifecycle command was not preserved');
  });

  await test('operator and skill-bound agent executors are accepted', async()=>{
    const result = evaluateProjectGraph({ nodes:[
      operatorNode('deterministic'),
      operatorNode('reasoning', { executor:{ kind:'agent', role:'source-research', skill:'jurisdiction-research' } }),
    ] });
    assert(byId(result,'deterministic').executor.kind === 'operator', 'operator executor changed');
    assert(byId(result,'reasoning').executor.skill === 'jurisdiction-research', 'agent skill was not retained');
  });

  await test('agent executor without a skill fails closed', async()=>{
    expectFailure(()=>evaluateProjectGraph({ nodes:[operatorNode('reasoning', { executor:{ kind:'agent', role:'source-research' } })] }), 'skill-free agent executor was accepted');
  });

  await test('invalid prerequisite topology fails closed', async()=>{
    expectFailure(()=>evaluateProjectGraph({ nodes:[operatorNode('a',{requires:['missing']})] }), 'missing dependency was accepted');
    expectFailure(()=>evaluateProjectGraph({ nodes:[operatorNode('a'),operatorNode('a')] }), 'duplicate node id was accepted');
    expectFailure(()=>evaluateProjectGraph({ nodes:[operatorNode('a',{requires:['a']})] }), 'self dependency was accepted');
    expectFailure(()=>evaluateProjectGraph({ nodes:[operatorNode('a',{requires:['b']}),operatorNode('b',{requires:['a']})] }), 'dependency cycle was accepted');
  });

  await test('invalid priorities and executors fail closed', async()=>{
    expectFailure(()=>evaluateProjectGraph({ nodes:[operatorNode('a',{priority:1.5})] }), 'fractional priority was accepted');
    expectFailure(()=>evaluateProjectGraph({ nodes:[operatorNode('a',{executor:{kind:'operator',command:''}})] }), 'empty operator command was accepted');
    expectFailure(()=>evaluateProjectGraph({ nodes:[operatorNode('a',{executor:{kind:'magic',command:'x'}})] }), 'unknown executor kind was accepted');
  });

  await test('graph completes only when every node is done', async()=>{
    const complete = evaluateProjectGraph({ nodes:[
      operatorNode('a',{lifecycle:{current_stage:'CONFIRM',responsibilities:doneResponsibilities()}}),
      operatorNode('b',{requires:['a'],lifecycle:{current_stage:'CONFIRM',responsibilities:doneResponsibilities()}}),
    ] });
    const incomplete = evaluateProjectGraph({ nodes:[operatorNode('a')] });
    assert(complete.complete === true, 'all-done graph was not complete');
    assert(incomplete.complete === false, 'incomplete graph was marked complete');
  });

  return { ok:tests.every(test=>test.ok), passed:tests.filter(test=>test.ok).length, failed:tests.filter(test=>!test.ok).length, tests };
}
