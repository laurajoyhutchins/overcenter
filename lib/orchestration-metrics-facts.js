export const EXECUTION_ORIGIN_CLASSES = Object.freeze([
  'system',
  'scheduler',
  'agent',
  'operator',
  'recovery',
  'unknown',
]);

const ORIGINS = new Set(EXECUTION_ORIGIN_CLASSES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalText(value, max) {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new Error('METRICS_INVOCATION_CONTEXT_INVALID');
  return text;
}

export function normalizeMetricsInvocationFacts(context) {
  if (context === undefined || context === null) {
    return Object.freeze({
      origin_class:'unknown',
      failure_invocation_id:null,
      recovery_decision:null,
      packet_schema:null,
      reasoning_boundary:false,
    });
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('METRICS_INVOCATION_CONTEXT_INVALID');
  const origin = optionalText(context.origin_class, 32) || 'unknown';
  if (!ORIGINS.has(origin)) throw new Error('METRICS_ORIGIN_CLASS_INVALID');
  const failureInvocationId = optionalText(context.failure_invocation_id, 64);
  if (failureInvocationId && !UUID.test(failureInvocationId)) throw new Error('METRICS_FAILURE_INVOCATION_ID_INVALID');
  const recoveryDecision = optionalText(context.recovery_decision, 128);
  if (Boolean(failureInvocationId) !== Boolean(recoveryDecision)) throw new Error('METRICS_RECOVERY_CORRELATION_INCOMPLETE');
  const packetSchema = optionalText(context.packet_schema, 128);
  return Object.freeze({
    origin_class:origin,
    failure_invocation_id:failureInvocationId,
    recovery_decision:recoveryDecision,
    packet_schema:packetSchema,
    reasoning_boundary:context.reasoning_boundary === true,
  });
}

export function recoveryCorrelationFact(invocation) {
  if (!invocation?.failure_invocation_id || !invocation?.recovery_decision) return null;
  return Object.freeze({
    failure_invocation_id:invocation.failure_invocation_id,
    recovery_decision:invocation.recovery_decision,
    recovery_attempt_invocation_id:invocation.invocation_id,
    recovery_outcome:invocation.outcome,
    resolved_without_new_reasoning_boundary:invocation.outcome === 'succeeded' && invocation.reasoning_boundary !== true,
  });
}