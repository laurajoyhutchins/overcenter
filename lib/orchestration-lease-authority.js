function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function object(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {}
  }
  return null;
}

const HISTORICAL_PROJECT_TRANSITION_CODES = new Set([
  'PROJECT_TRANSITION_AUTHORITY_STALE',
  'PROJECT_TRANSITION_LEASE_STALE',
]);

export function durableLeaseSubject(lease) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
    fail('ORCHESTRATION_LEASE_SUBJECT_INVALID', 'active lease authority is unavailable');
  }
  const gate = typeof lease.gate === 'string' ? lease.gate.trim() : '';
  const receipt = object(lease.claim_receipt) || {};
  const receiptSubject = typeof receipt.subject === 'string' ? receipt.subject.trim().toLowerCase() : '';
  const gateIsProjectTransition = gate === 'project_transition';
  const receiptIsProjectTransition = receiptSubject === 'project_transition';
  if (gateIsProjectTransition !== receiptIsProjectTransition) {
    fail('ORCHESTRATION_LEASE_SUBJECT_INVALID', 'durable lease subject evidence is ambiguous', {
      lease_ref:lease.lease_id || null,
      gate:gate || null,
      receipt_subject:receiptSubject || null,
    });
  }
  return gateIsProjectTransition ? 'project_transition' : 'legacy_work';
}

export async function classifyLeaseAuthority({ lease, projectTransitions, run_id = null } = {}) {
  const subject = durableLeaseSubject(lease);
  if (subject === 'legacy_work') {
    return Object.freeze({ subject, authority_status:'current', current:true, historical:false, authority:null, historical_reason:null });
  }
  if (!projectTransitions || typeof projectTransitions.require !== 'function') {
    fail('ORCHESTRATION_LEASE_AUTHORITY_UNAVAILABLE', 'project-transition authority validation is unavailable', {
      lease_ref:lease?.lease_id || null,
    });
  }
  try {
    const authority = await projectTransitions.require({
      lease_ref:lease.lease_id,
      ...(run_id ? { run_id } : {}),
    });
    return Object.freeze({ subject, authority_status:'current', current:true, historical:false, authority, historical_reason:null });
  } catch (error) {
    if (HISTORICAL_PROJECT_TRANSITION_CODES.has(String(error?.code || ''))) {
      return Object.freeze({
        subject,
        authority_status:'historical',
        current:false,
        historical:true,
        authority:null,
        historical_reason:String(error.code),
        details:error?.details || null,
      });
    }
    throw error;
  }
}

export function createSubjectAwareActiveLeaseStore({ store, projectTransitions, readCandidates = null } = {}) {
  if (!store) throw new TypeError('store is required');
  const candidatesFor = typeof readCandidates === 'function'
    ? readCandidates
    : async (runId, observedAt) => {
      if (typeof store.activeLeasesForRun === 'function') return store.activeLeasesForRun(runId, observedAt);
      if (typeof store.activeLeaseForRun !== 'function') return [];
      const lease = await store.activeLeaseForRun(runId, observedAt);
      return lease ? [lease] : [];
    };

  async function activeLeaseForRun(runId, observedAt) {
    const candidates = await candidatesFor(runId, observedAt);
    const current = [];
    for (const lease of Array.isArray(candidates) ? candidates : []) {
      const classification = await classifyLeaseAuthority({ lease, projectTransitions, run_id:runId });
      if (classification.current) current.push({ lease, classification });
    }
    if (current.length > 1) {
      fail('ORCHESTRATION_LEASE_AUTHORITY_AMBIGUOUS', 'multiple current execution authorities remain for one orchestration run', {
        run_id:runId,
        lease_refs:current.map(({ lease }) => lease.lease_id).filter(Boolean).sort(),
      });
    }
    return current[0]?.lease || null;
  }

  return new Proxy(store, {
    get(source, property, receiver) {
      if (property === 'activeLeaseForRun') return activeLeaseForRun;
      const value = Reflect.get(source, property, receiver);
      return typeof value === 'function' ? value.bind(source) : value;
    },
  });
}

export function projectTransitionLeaseProjection(lease, classification) {
  const receipt = object(lease?.claim_receipt) || {};
  const transition = object(receipt.project_transition) || {};
  const currentAuthority = classification?.authority?.authority || null;
  return Object.freeze({
    lease_id:lease?.lease_id || null,
    work_ref:lease?.work_ref || null,
    gate:lease?.gate || null,
    run_id:lease?.run_id || null,
    status:lease?.status || null,
    created_at:lease?.created_at || null,
    expires_at:lease?.expires_at || null,
    subject:'project_transition',
    authority_status:classification?.authority_status || 'historical',
    historical_reason:classification?.historical_reason || null,
    project_ref:transition.project_ref || classification?.authority?.project_ref || null,
    transition_id:transition.transition_id || classification?.authority?.transition_id || null,
    repository:transition.repository || classification?.authority?.repository || null,
    claimed_authority_revision:transition.authority_revision || null,
    current_authority_revision:currentAuthority?.revision || classification?.details?.actual_revision || null,
  });
}