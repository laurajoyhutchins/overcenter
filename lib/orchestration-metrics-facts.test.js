import {
  EXECUTION_ORIGIN_CLASSES,
  normalizeMetricsInvocationFacts,
  recoveryCorrelationFact,
} from 'lib/orchestration-metrics-facts.js';

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

async function run(name, fn) {
  try {
    await fn();
    return { name, ok:true };
  } catch (error) {
    return { name, ok:false, error:String(error?.message || error) };
  }
}

export async function runOrchestrationMetricsFactsTests() {
  const results = [];

  results.push(await run('origin classification is low-cardinality and historical origin remains unknown', async () => {
    assert(EXECUTION_ORIGIN_CLASSES.join(',') === 'system,scheduler,agent,operator,recovery,unknown');
    assert(normalizeMetricsInvocationFacts(null).origin_class === 'unknown');
    assert(normalizeMetricsInvocationFacts({ origin_class:'operator' }).origin_class === 'operator');
    assert(normalizeMetricsInvocationFacts({ origin_class:'recovery' }).origin_class === 'recovery');
  }));

  results.push(await run('recovery correlation reuses invocation identity from failure through outcome', async () => {
    const failureId = '11111111-1111-4111-8111-111111111111';
    const attemptId = '22222222-2222-4222-8222-222222222222';
    const facts = normalizeMetricsInvocationFacts({
      origin_class:'recovery',
      failure_invocation_id:failureId,
      recovery_decision:'retry_same_request',
      reasoning_boundary:false,
    });
    const correlation = recoveryCorrelationFact({ ...facts, invocation_id:attemptId, outcome:'succeeded' });
    assert(correlation.failure_invocation_id === failureId);
    assert(correlation.recovery_attempt_invocation_id === attemptId);
    assert(correlation.recovery_outcome === 'succeeded');
    assert(correlation.resolved_without_new_reasoning_boundary === true);
  }));

  results.push(await run('operator paperwork and automated recovery remain distinguishable', async () => {
    const operator = normalizeMetricsInvocationFacts({ origin_class:'operator', reasoning_boundary:true });
    const recovery = normalizeMetricsInvocationFacts({
      origin_class:'recovery',
      failure_invocation_id:'33333333-3333-4333-8333-333333333333',
      recovery_decision:'reconcile_authority',
      reasoning_boundary:false,
    });
    assert(operator.origin_class !== recovery.origin_class);
    assert(operator.reasoning_boundary === true);
    assert(recovery.reasoning_boundary === false);
  }));

  results.push(await run('partial recovery correlation fails closed instead of guessing', async () => {
    let failed = false;
    try {
      normalizeMetricsInvocationFacts({ origin_class:'recovery', recovery_decision:'retry_same_request' });
    } catch { failed = true; }
    assert(failed, 'partial recovery correlation was accepted');
  }));

  return {
    ok:results.every((result)=>result.ok),
    passed:results.filter((result)=>result.ok).length,
    failed:results.filter((result)=>!result.ok).length,
    results,
  };
}