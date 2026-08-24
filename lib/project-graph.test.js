import { evaluateProjectFrontier } from './project-graph.js';

function assert(value, message) { if (!value) throw new Error(message); }

export async function runProjectGraphTests() {
  const tests = [];
  async function test(name, fn) { try { await fn(); tests.push({ name, ok:true }); } catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); } }

  await test('frontier excludes already satisfied transitions and enables satisfied-dependency successors', async () => {
    const result = evaluateProjectFrontier({ transitions:[
      { id:'source-known', state:'satisfied' },
      { id:'candidate-prepared', state:'pending', depends_on:['source-known'], priority:20 },
      { id:'verify-candidate', state:'pending', depends_on:['candidate-prepared'], priority:100 },
    ] });
    assert(result.enabled.length === 1 && result.enabled[0].id === 'candidate-prepared', 'frontier did not select the immediate enabled transition');
    assert(result.satisfied_count === 1 && result.pending_count === 2, 'frontier counts were incorrect');
  });

  await test('frontier is deterministic by priority then transition identity', async () => {
    const result = evaluateProjectFrontier({ transitions:[
      { id:'beta', state:'pending', priority:10 },
      { id:'alpha', state:'pending', priority:10 },
      { id:'urgent', state:'pending', priority:50 },
      { id:'blocked', state:'blocked', priority:1000 },
    ] });
    assert(result.enabled.map(item => item.id).join(',') === 'urgent,alpha,beta', 'frontier ordering was not deterministic');
  });

  await test('missing dependencies fail closed', async () => {
    let error = null;
    try { evaluateProjectFrontier({ transitions:[{ id:'candidate', state:'pending', depends_on:['missing'] }] }); } catch (caught) { error = caught; }
    assert(String(error?.message || '') === 'PROJECT_GRAPH_MISSING_DEPENDENCY:candidate:missing', 'missing dependency was not rejected');
  });

  await test('cycles fail closed', async () => {
    let error = null;
    try { evaluateProjectFrontier({ transitions:[
      { id:'a', state:'pending', depends_on:['b'] },
      { id:'b', state:'pending', depends_on:['a'] },
    ] }); } catch (caught) { error = caught; }
    assert(String(error?.message || '').startsWith('PROJECT_GRAPH_CYCLE:'), 'cycle was not rejected');
  });

  const failed = tests.filter(result => !result.ok);
  if (failed.length) throw new Error(`project graph regression failures: ${JSON.stringify(failed)}`);
  return { ok:true, tests };
}
