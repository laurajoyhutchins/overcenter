import { canonicalJson, sha256Text } from './canonical-json.js';

const WORKFLOW_PATH = '.github/workflows/exact-revision-v8.yml';

function fail(message, details = {}) {
  throw Object.assign(new Error(message), {
    code:'GITHUB_PRODUCTION_PROMOTION_VERIFICATION_REQUIRED',
    details,
  });
}

function exactVerification(run, normalized, branchRoles) {
  return Number(run?.id) === Number(normalized.verification_run_id)
    && String(run?.path || '') === WORKFLOW_PATH
    && String(run?.event || '') === 'push'
    && String(run?.head_branch || '') === String(branchRoles?.development_branch || '')
    && String(run?.head_sha || '').toLowerCase() === String(normalized.candidate_sha || '').toLowerCase()
    && String(run?.status || '') === 'completed'
    && String(run?.conclusion || '') === 'success';
}

function evidence(normalized, branchRoles, workflowRun) {
  return Object.freeze({
    repository:normalized.repo,
    authority_revision:String(normalized.candidate_sha).toLowerCase(),
    workflow_path:WORKFLOW_PATH,
    workflow_run_id:Number(workflowRun.id),
    workflow_event:String(workflowRun.event),
    workflow_head_branch:String(workflowRun.head_branch),
    workflow_head_sha:String(workflowRun.head_sha).toLowerCase(),
    workflow_status:String(workflowRun.status),
    workflow_conclusion:String(workflowRun.conclusion),
    development_branch:String(branchRoles.development_branch),
  });
}

export async function persistExactProductionVerificationProof({
  proofs,
  normalized,
  branchRoles,
  workflowRun,
  observedAt = new Date().toISOString(),
} = {}) {
  if (!proofs || typeof proofs.satisfy !== 'function' || typeof proofs.findSatisfied !== 'function') {
    throw new TypeError('proofs store is required');
  }
  if (!normalized || typeof normalized !== 'object' || !branchRoles || typeof branchRoles !== 'object') {
    throw new TypeError('normalized promotion request and branch roles are required');
  }
  if (!exactVerification(workflowRun, normalized, branchRoles)) {
    fail('candidate does not have successful exact-revision V8 verification from a development-branch push', {
      candidate_sha:normalized.candidate_sha || null,
      verification_run_id:normalized.verification_run_id || null,
      observed_event:workflowRun?.event || null,
      observed_head_branch:workflowRun?.head_branch || null,
      observed_head_sha:workflowRun?.head_sha || null,
      observed_status:workflowRun?.status || null,
      observed_conclusion:workflowRun?.conclusion || null,
    });
  }

  const authorityRevision = String(normalized.candidate_sha).toLowerCase();
  const subjectKey = `repository:${normalized.repo}`;
  const proofKey = `exact-revision-v8:${normalized.repo}:${authorityRevision}:${Number(workflowRun.id)}`;
  const proofEvidence = evidence(normalized, branchRoles, workflowRun);
  const proof = await proofs.satisfy({
    proof_key:proofKey,
    subject_key:subjectKey,
    predicate_kind:'exact_revision_v8_satisfied',
    authority_repository:normalized.repo,
    authority_revision:authorityRevision,
    evidence_sha256:await sha256Text(canonicalJson(proofEvidence)),
    evidence_refs:[{
      kind:'github_workflow_run',
      ref:workflowRun?.html_url ? String(workflowRun.html_url) : `github-workflow-run:${Number(workflowRun.id)}`,
    }],
    satisfied_at:new Date(observedAt).toISOString(),
  });

  const exact = await proofs.findSatisfied({
    subject_key:subjectKey,
    predicate_kind:'exact_revision_v8_satisfied',
    authority_repository:normalized.repo,
    authority_revision:authorityRevision,
  });
  if (!exact || exact.proof_key !== proof.proof_key) {
    fail('exact-revision verification proof was not durably readable after persistence', {
      candidate_sha:authorityRevision,
      verification_run_id:Number(workflowRun.id),
    });
  }
  return exact;
}
