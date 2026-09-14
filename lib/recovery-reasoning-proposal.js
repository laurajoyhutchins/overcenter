const DISPOSITIONS = new Set(['recover','requeue','block','supersede','owner_escalation']);
const FORBIDDEN_AUTHORITY_FIELDS = new Set(['lease_token','lease_ref','authority_epoch','expected_head','credential','credentials']);

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function asObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RECOVERY_PROPOSAL_INVALID', `${field} must be an object`, { field });
  return value;
}

function assertNoAuthority(value, path = 'proposal') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoAuthority(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_AUTHORITY_FIELDS.has(key)) fail('RECOVERY_PROPOSAL_AUTHORITY_FORBIDDEN', 'reasoning proposals cannot carry execution authority', { field:`${path}.${key}` });
    assertNoAuthority(entry, `${path}.${key}`);
  }
}

export function validateRecoveryReasoningProposal({ packet, proposal, current_authority_revision } = {}) {
  const boundedPacket = asObject(packet, 'packet');
  const candidate = asObject(proposal, 'proposal');
  if (boundedPacket.schema !== 'recovery-reasoning-packet-v1') fail('RECOVERY_PACKET_INVALID', 'unsupported recovery reasoning packet schema');
  if (candidate.schema !== 'recovery-reasoning-proposal-v1') fail('RECOVERY_PROPOSAL_INVALID', 'unsupported recovery reasoning proposal schema');
  if (!boundedPacket.advisory_only || !boundedPacket.requires_authority_reacquisition) fail('RECOVERY_PACKET_UNSAFE', 'reasoning packet must remain advisory and require authority reacquisition');
  if (candidate.reasoning_boundary_id !== boundedPacket.reasoning_boundary_id) fail('RECOVERY_PROPOSAL_IDENTITY_MISMATCH', 'proposal reasoning boundary does not match packet');
  if (candidate.fault_ref !== boundedPacket.fault_ref) fail('RECOVERY_PROPOSAL_IDENTITY_MISMATCH', 'proposal fault identity does not match packet');
  if (candidate.authority_revision !== boundedPacket.authority_revision) fail('RECOVERY_PROPOSAL_IDENTITY_MISMATCH', 'proposal authority identity does not match packet');
  if (!current_authority_revision || current_authority_revision !== boundedPacket.authority_revision) fail('RECOVERY_PROPOSAL_AUTHORITY_STALE', 'current authority moved while reasoning was in flight', { packet_authority:boundedPacket.authority_revision, current_authority:current_authority_revision || null });
  if (!DISPOSITIONS.has(candidate.disposition)) fail('RECOVERY_PROPOSAL_INVALID', 'proposal disposition is unsupported', { disposition:candidate.disposition });
  if (candidate.healed === true || candidate.verified === true) fail('RECOVERY_PROPOSAL_VERIFICATION_FORBIDDEN', 'reasoning cannot claim recovery verification');
  if ('actions' in candidate) fail('RECOVERY_PROPOSAL_ACTIONS_FORBIDDEN', 'reasoning returns semantic intent, not executable actions');
  assertNoAuthority(candidate);
  if (candidate.disposition === 'recover') {
    const intent = asObject(candidate.semantic_intent, 'proposal.semantic_intent');
    if (typeof intent.command !== 'string' || !intent.command.trim()) fail('RECOVERY_PROPOSAL_INVALID', 'recover disposition requires one semantic command intent');
  }
  return Object.freeze({
    schema:'validated-recovery-reasoning-proposal-v1',
    reasoning_boundary_id:candidate.reasoning_boundary_id,
    fault_ref:candidate.fault_ref,
    authority_revision:candidate.authority_revision,
    disposition:candidate.disposition,
    semantic_intent:candidate.semantic_intent || null,
    reason:typeof candidate.reason === 'string' ? candidate.reason : null,
    advisory_only:true,
    verified:false,
    requires_authority_reacquisition:true,
    invocation_context:boundedPacket.invocation_context || null,
  });
}
