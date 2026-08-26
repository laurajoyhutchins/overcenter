import { evaluateProjectHorizon } from './project-horizon.js';
import { PRODUCTIVE_STAGES } from './work-lifecycle.js';

function assert(value, message) { if (!value) throw new Error(message); }

function doneResponsibilities() {
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage) => [stage, { applicable:true, satisfied:true }]));
}

function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, {
    applicable:true,
    satisfied:stageIndex < index,
  }]));
}

function operatorNode(id, overrides = {}) {
  return {
    id,
    priority:0,
    requires:[],
    lifecycle:{ current_stage:'ENABLE', responsibilities:responsibilitiesFor('ENABLE') },
    executor:{ kind:'operator', command:'test.noop' },
    ...overrides,
  };
}

function doneNode(id, overrides = {}) {
  return operatorNode(id, {
    lifecycle:{ current_stage:'CONFIRM', responsibilities:doneResponsibilities() },
    ...overrides,
  });
}

function authoritativeGraph(nodes, horizons = [], revision = 'a'.repeat(40)) {
  return {
    schema:'project-graph-authority-v1',
    project_ref:'example-project',
    authority:{
      definition:{
        kind:'github',
        repository:'example/project',
        revision,
        derivation:'example-project-graph-v1',
      },
      observations:[],
    },
    nodes,
    horizons,
  };
}

function expectFailure(fn, code, message) {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  assert(error, message);
  assert(error.code === code, `${message}: expected ${code}, got ${error?.code || 'no code'}`);
}

export async function runProjectHorizonTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('transition horizon includes prerequisite closure and selects only in-scope frontier', async()=> {
    const graph = authoritativeGraph([
      operatorNode('source', { priority:1 }),
      operatorNode('build', { priority:10, requires:['source'] }),
      operatorNode('unrelated', { priority:100 }),
    ]);
    const result = evaluateProjectHorizon(graph, { kind:'transition', ref:'build' });
    assert(result.horizon.scope_node_ids.join(',') === 'build,source', 'transition horizon did not include exact prerequisite closure');
    assert(result.frontier.map((node) => node.id).join(',') === 'source', 'transition horizon frontier escaped its scoped dependency path');
    assert(!result.nodes.some((node) => node.id === 'unrelated'), 'unrelated node entered transition horizon');
  });

  await test('milestone horizon can complete independently of unrelated project work', async()=> {
    const graph = authoritativeGraph([
      doneNode('schema'),
      doneNode('validator', { requires:['schema'] }),
      operatorNode('future-work'),
    ], [
      { kind:'milestone', ref:'v1-foundation', target_node_ids:['validator'] },
    ]);
    const result = evaluateProjectHorizon(graph, { kind:'milestone', ref:'v1-foundation' });
    assert(result.complete === true, 'verified milestone subset was not complete');
    assert(result.horizon.target_node_ids.join(',') === 'validator', 'milestone target identity changed');
    assert(result.horizon.scope_node_ids.join(',') === 'schema,validator', 'milestone did not include prerequisite closure');
    assert(!result.nodes.some((node) => node.id === 'future-work'), 'unrelated project work prevented milestone completion');
  });

  await test('project horizon requires every project transition to be done', async()=> {
    const incomplete = evaluateProjectHorizon(authoritativeGraph([
      doneNode('a'),
      operatorNode('b', { requires:['a'] }),
    ]), { kind:'project', ref:'example-project' });
    const complete = evaluateProjectHorizon(authoritativeGraph([
      doneNode('a'),
      doneNode('b', { requires:['a'] }),
    ]), { kind:'project', ref:'example-project' });
    assert(incomplete.complete === false, 'incomplete project horizon was marked complete');
    assert(complete.complete === true, 'all-done project horizon was not complete');
  });

  await test('off-nominal transition blocks only its horizon and never enters ready frontier', async()=> {
    const graph = authoritativeGraph([
      operatorNode('faulted', {
        lifecycle:{ current_stage:'EXECUTE', condition:'FAULT', responsibilities:responsibilitiesFor('COMMIT') },
      }),
      operatorNode('unrelated'),
    ], [
      { kind:'milestone', ref:'faulted-milestone', target_node_ids:['faulted'] },
    ]);
    const result = evaluateProjectHorizon(graph, { kind:'milestone', ref:'faulted-milestone' });
    assert(result.complete === false, 'off-nominal milestone was marked complete');
    assert(result.frontier.length === 0, 'off-nominal transition entered horizon frontier');
    assert(result.off_nominal.map((node) => node.id).join(',') === 'faulted', 'off-nominal evidence was not retained');
  });

  await test('explicit horizon definition fails closed on missing target nodes', async()=> {
    const graph = authoritativeGraph([operatorNode('present')], [
      { kind:'milestone', ref:'broken', target_node_ids:['missing'] },
    ]);
    expectFailure(
      () => evaluateProjectHorizon(graph, { kind:'milestone', ref:'broken' }),
      'PROJECT_HORIZON_DEFINITION_INVALID',
      'missing milestone target node was accepted',
    );
  });

  await test('stale authority coordinates invalidate prior horizon evidence', async()=> {
    const graph = authoritativeGraph([operatorNode('a')], [], 'b'.repeat(40));
    expectFailure(
      () => evaluateProjectHorizon(
        graph,
        { kind:'transition', ref:'a' },
        { expected_authority:{
          kind:'github',
          repository:'example/project',
          revision:'a'.repeat(40),
          derivation:'example-project-graph-v1',
        } },
      ),
      'PROJECT_HORIZON_AUTHORITY_STALE',
      'stale horizon authority was accepted',
    );
  });

  await test('release and portfolio horizons use the same verified subset semantics', async()=> {
    const graph = authoritativeGraph([
      doneNode('protocol'),
      doneNode('consumer', { requires:['protocol'] }),
      operatorNode('later'),
    ], [
      { kind:'release', ref:'v1', target_node_ids:['consumer'] },
      { kind:'portfolio', ref:'adoption-wave', target_node_ids:['consumer'] },
    ]);
    const release = evaluateProjectHorizon(graph, { kind:'release', ref:'v1' });
    const portfolio = evaluateProjectHorizon(graph, { kind:'portfolio', ref:'adoption-wave' });
    assert(release.complete === true, 'release horizon did not compose from verified transitions');
    assert(portfolio.complete === true, 'portfolio horizon did not compose from verified transitions');
    assert(release.horizon.scope_node_ids.join(',') === portfolio.horizon.scope_node_ids.join(','), 'composed horizon semantics diverged by altitude');
  });

  return {
    ok:tests.every((entry) => entry.ok),
    passed:tests.filter((entry) => entry.ok).length,
    failed:tests.filter((entry) => !entry.ok).length,
    tests,
  };
}
