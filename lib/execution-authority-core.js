import { canonicalJson, sha256Text } from './canonical-json.js';
import { normalizeAllowedExecutionGates, normalizeExecutionAuthorityLocator } from './execution-authority-contracts.js';
import { repositoryIdentity } from './work-identity.js';

export class ExecutionAuthorityError extends Error {
  constructor(code, message, details = null, httpStatus = 409) {
    super(message);
    this.name = 'ExecutionAuthorityError';
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

function fail(code, message, details = null, httpStatus = 409) {
  throw new ExecutionAuthorityError(code, message, details, httpStatus);
}

function parseJson(value) {
  if (value === null || value === undefined || typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function instant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function projectionMatchesExpected(current, expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
  const comparable = {};
  for (const key of Object.keys(expected)) comparable[key] = current?.[key];
  return canonicalJson(comparable) === canonicalJson(expected);
}

function projectionDiff(expected, current) {
  const keys = [...new Set([...Object.keys(expected || {}), ...Object.keys(current || {})])].sort();
  return keys.filter(key => canonicalJson(expected?.[key]) !== canonicalJson(current?.[key]));
}

export function createExecutionAuthorityService({ store, authoritative, executionProjection, projectTransitions = null, now = () => new Date().toISOString() } = {}) {
  if (!store || typeof store.getLeaseByTokenHash !== 'function' || typeof store.getSlot !== 'function' || typeof store.getRun !== 'function') {
    throw new Error('execution authority store must provide lease, slot, and run reads');
  }
  if (!authoritative || typeof authoritative.getIssue !== 'function') {
    throw new Error('execution authority requires authoritative work reads');
  }
  if (typeof executionProjection !== 'function') {
    throw new Error('execution authority requires an execution projection function');
  }

  return {
    async require(input = {}) {
      const repository = repositoryIdentity(input.repository) || null;
      const locator = normalizeExecutionAuthorityLocator(input, repository, fail);
      const leaseToken = locator.lease_token || '';
      const leaseRef = locator.lease_ref || '';
      if (leaseRef && typeof store.getLeaseById !== 'function') {
        fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'Overcenter could not read execution authority by lease reference', {
          phase: 'lease_read',
        }, 503);
      }

      const allowedGates = normalizeAllowedExecutionGates(input.allowed_gates);

      let lease;
      try {
        lease = leaseRef
          ? await store.getLeaseById(leaseRef)
          : await store.getLeaseByTokenHash(await sha256Text(leaseToken));
      } catch (error) {
        fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'Overcenter could not read execution authority state', {
          phase: 'lease_read',
          upstream_code: error?.code || null,
        }, 503);
      }
      if (!lease) fail('EXECUTION_AUTHORITY_INVALID', 'execution authority locator is unknown');

      const observedNow = instant(now());
      if (observedNow === null) throw new Error('execution authority clock returned an invalid instant');
      const leaseExpiry = instant(lease.expires_at);
      const hardExpiry = lease.hard_expires_at ? instant(lease.hard_expires_at) : null;
      if (lease.status !== 'active' || leaseExpiry === null || leaseExpiry <= observedNow || (hardExpiry !== null && hardExpiry <= observedNow)) {
        fail('EXECUTION_AUTHORITY_STALE', 'execution authority lease is not active', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
          gate: lease.gate || null,
          reason: lease.status !== 'active' ? 'lease_status' : 'lease_expired',
        });
      }

      if (!allowedGates.has(lease.gate)) {
        fail('EXECUTION_AUTHORITY_SCOPE_MISMATCH', 'execution authority does not cover this mutation gate', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
          gate: lease.gate || null,
          allowed_gates: [...allowedGates].sort(),
        });
      }

      let slot;
      let run;
      try {
        [slot, run] = await Promise.all([
          store.getSlot(lease.work_ref, lease.gate),
          store.getRun(lease.run_id),
        ]);
      } catch (error) {
        fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'Overcenter could not confirm current execution ownership', {
          phase: 'ownership_read',
          upstream_code: error?.code || null,
        }, 503);
      }
      const slotExpiry = instant(slot?.expires_at);
      if (!slot || slot.lease_id !== lease.lease_id || slotExpiry === null || slotExpiry <= observedNow) {
        fail('EXECUTION_AUTHORITY_STALE', 'execution authority no longer owns the active work slot', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
          gate: lease.gate || null,
          reason: 'slot_not_owned',
        });
      }

      const runDeadline = instant(run?.deadline_at);
      if (!run || run.status !== 'active' || runDeadline === null || runDeadline <= observedNow) {
        fail('EXECUTION_AUTHORITY_STALE', 'execution authority run is no longer active', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
          run_id: lease.run_id || null,
          gate: lease.gate || null,
          reason: 'run_not_active',
        });
      }

      const claimReceipt = parseJson(lease.claim_receipt);
      if (claimReceipt?.subject === 'project_transition') {
        const subject = claimReceipt?.project_transition;
        const requestedRepository = repositoryIdentity(input.repository);
        const subjectRepository = repositoryIdentity(subject?.repository);
        if (!subject || typeof subject !== 'object' || Array.isArray(subject)
            || !subject.project_ref || !subject.transition_id || !requestedRepository || !subjectRepository) {
          fail('EXECUTION_AUTHORITY_INVALID', 'project transition execution authority is missing durable subject identity', {
            lease_id:lease.lease_id || null,
          });
        }
        if (requestedRepository !== subjectRepository) {
          fail('EXECUTION_AUTHORITY_SCOPE_MISMATCH', 'project transition execution authority does not cover the requested repository', {
            lease_id:lease.lease_id || null,
            repository:requestedRepository || null,
            authorized_repository:subjectRepository || null,
          });
        }
        if (!projectTransitions || typeof projectTransitions.require !== 'function') {
          fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'project transition execution authority validator is unavailable', {
            phase:'project_transition_authority_read',
          }, 503);
        }
        let verified;
        try {
          verified = await projectTransitions.require({
            lease_ref:lease.lease_id,
            run_id:lease.run_id,
            project_ref:String(subject.project_ref),
            transition_id:String(subject.transition_id),
            repository:subjectRepository,
          });
        } catch (error) {
          if (String(error?.code || '').startsWith('PROJECT_TRANSITION_')) {
            fail('EXECUTION_AUTHORITY_STALE', 'project transition execution authority is no longer valid', {
              phase:'project_transition_authority_read',
              upstream_code:error.code,
              upstream_details:error.details || null,
            });
          }
          throw error;
        }
        if (!verified || verified.subject !== 'project_transition' || repositoryIdentity(verified.repository) !== subjectRepository) {
          fail('EXECUTION_AUTHORITY_INVALID', 'project transition authority validator returned inconsistent subject evidence', {
            lease_id:lease.lease_id || null,
          });
        }
        return {
          subject:'project_transition',
          work_ref:lease.work_ref,
          lease_id:lease.lease_id,
          lease_ref:lease.lease_id,
          run_id:lease.run_id,
          gate:lease.gate,
          repository:subjectRepository,
          project_ref:verified.project_ref,
          transition_id:verified.transition_id,
          authority:verified.authority || null,
          graph_fingerprint:verified.graph_fingerprint || null,
        };
      }

      const claimProjection = claimReceipt?.execution_projection;
      if (!claimProjection || typeof claimProjection !== 'object' || Array.isArray(claimProjection)) {
        fail('EXECUTION_AUTHORITY_INVALID', 'execution authority lacks a durable execution projection', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
        });
      }

      const requestedRepository = repositoryIdentity(input.repository);
      const leaseRepository = repositoryIdentity(claimProjection.repository);
      if (!requestedRepository || !leaseRepository || requestedRepository !== leaseRepository) {
        fail('EXECUTION_AUTHORITY_SCOPE_MISMATCH', 'execution authority does not cover the requested repository', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
          gate: lease.gate || null,
          repository: requestedRepository || null,
          authorized_repository: leaseRepository || null,
        });
      }

      let issue;
      try {
        issue = await authoritative.getIssue(lease.work_ref);
      } catch (error) {
        fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'Overcenter could not re-read authoritative work state', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
          phase: 'authoritative_work_read',
          upstream_code: error?.code || null,
        }, 503);
      }
      const currentProjection = executionProjection(issue);
      if (!projectionMatchesExpected(currentProjection, claimProjection)) {
        fail('EXECUTION_AUTHORITY_STALE', 'authoritative work state changed after the lease was claimed', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
          gate: lease.gate || null,
          reason: 'work_state_changed',
          changed_fields: projectionDiff(claimProjection, currentProjection),
        });
      }

      return {
        work_ref: lease.work_ref,
        lease_id: lease.lease_id,
        run_id: lease.run_id,
        gate: lease.gate,
        repository: leaseRepository,
        execution_fingerprint: claimReceipt?.execution_fingerprint || null,
      };
    },
  };
}