import { projectTransitionObligationFingerprint } from './project-transition-certificate-settlement.js';

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function frozen(values) { return Object.freeze(values); }

function nextBoundary(transition, occupancy) {
  if (transition?.state === 'DONE') return Object.freeze({ kind:'complete', stop_condition:'transition is authoritatively DONE' });
  if (transition?.state === 'OFF_NOMINAL') return Object.freeze({ kind:'operator_action', stop_condition:'off-nominal state requires explicit recovery judgment' });
  if (occupancy?.suspended === true || transition?.state === 'WAITING') return Object.freeze({ kind:'external_wait', stop_condition:text(occupancy?.suspension_reason || occupancy?.wait_reason) || 'declared prerequisites or external promotion conditions remain unresolved', ...(occupancy?.suspension?.recovery_ref ? { recovery_ref:String(occupancy.suspension.recovery_ref) } : {}) });
  if (occupancy?.occupied === true) return Object.freeze({ kind:'external_wait', stop_condition:'another execution owns the active transition lease' });
  if (transition?.executor?.kind === 'operator') return Object.freeze({ kind:'deterministic_action', command:text(transition?.executor?.command) || null, stop_condition:'execute only the declared deterministic operator' });
  return Object.freeze({ kind:'reasoning_judgment', stop_condition:'perform only the bounded judgment-heavy work required by the execution intent' });
}

function acceptanceObligations(transition, evidence, authorityRevision) {
  const observed = new Map();
  for (const item of evidence) {
    const kind = text(item?.kind);
    const current = !item?.authority_revision || String(item.authority_revision) === String(authorityRevision);
    if (kind && current && !observed.has(kind)) observed.set(kind, item);
  }
  return frozen((transition?.execution_intent?.acceptance_evidence || []).map((requirement) => {
    const kind = text(requirement?.kind);
    const proof = observed.get(kind) || null;
    return Object.freeze({ kind, requirement:text(requirement?.requirement), status:proof ? 'satisfied' : 'unresolved', evidence_ref:proof && text(proof.ref) ? text(proof.ref) : null });
  }));
}

export async function deriveProjectTransitionProofState(input = {}) {
  const transition = input.transition || {};
  const authority = input.authority || {};
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const obligations = acceptanceObligations(transition, evidence, authority.revision);
  const staleEvidence = evidence.filter((item) => item?.authority_revision && String(item.authority_revision) !== String(authority.revision)).map((item) => text(item.kind)).filter(Boolean);
  return Object.freeze({ schema:'project-transition-proof-state-v1', transition_id:text(transition.id), desired_outcome:text(transition?.execution_intent?.desired_outcome) || null, obligation_fingerprint:await projectTransitionObligationFingerprint(transition), authority:Object.freeze({ kind:text(authority.kind), repository:text(authority.repository), revision:text(authority.revision), derivation:text(authority.derivation) }), acceptance_obligations:obligations, unresolved_obligations:frozen(obligations.filter((item) => item.status !== 'satisfied').map((item) => item.kind)), valid_evidence:frozen(evidence.filter((item) => !item?.authority_revision || String(item.authority_revision) === String(authority.revision)).map((item) => Object.freeze({ kind:text(item.kind), ref:text(item.ref) || null }))), stale:Object.freeze({ value:staleEvidence.length > 0, evidence_kinds:frozen([...new Set(staleEvidence)].sort()) }), next_legal_action:nextBoundary(transition, input.occupancy || null) });
}
