import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
import { mayHaveMutated, mergeMutationCertainty, mutationCertaintyFromEvidence } from 'lib/mutation-certainty.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;
const WORKFLOW_PATH = '.github/workflows/exact-revision-v8.yml';

function failure(error, message, details = {}, mayHaveMutated = false) {
  return { ok: false, error, message, ...details, may_have_mutated: mayHaveMutated };
}

function errorAfterMutationBoundary(errorInput, floor) {
  const source = errorInput && typeof errorInput === 'object' && !Array.isArray(errorInput) ? errorInput : null;
  const error = errorInput instanceof Error ? errorInput : new Error(String(source?.message || errorInput || 'production promotion failed after mutation boundary'));
  const certainty = mergeMutationCertainty(floor, mutationCertaintyFromEvidence(source || error, 'none'));
  const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? error.details : {};
  error.may_have_mutated = mayHaveMutated(certainty);
  error.details = Object.freeze({ ...details, mutation_certainty: certainty, may_have_mutated: error.may_have_mutated });
  return error;
}

function requiredString(value, field, max = 512) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw Object.assign(new Error(`${field} is invalid`), { code: 'INVALID_REQUEST', details: { field } });
  return text;
}

function exactSha(value, field) {
  const sha = requiredString(value, field, 40).toLowerCase();
  if (!SHA40.test(sha)) throw Object.assign(new Error(`${field} must be a full Git commit SHA`), { code: 'INVALID_REQUEST', details: { field } });
  return sha;
}

export function normalizeGithubProductionPromotionRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('request must be an object'), { code: 'INVALID_REQUEST' });
  const allowed = new Set(['repo','candidate_sha','observed_development_head','observed_production_head','verification_run_id','idempotency_key']);
  const unknown = Object.keys(input).filter(key => !allowed.has(key)).sort();
  if (unknown.length) throw Object.assign(new Error('request contains unsupported fields'), { code: 'INVALID_REQUEST', details: { unsupported_fields: unknown } });
  const repo = requiredString(input.repo, 'repo', 256);
  if (!REPO.test(repo)) throw Object.assign(new Error('repo must be owner/repo'), { code: 'INVALID_REQUEST', details: { field: 'repo' } });
  const verificationRunId = Number(input.verification_run_id);
  if (!Number.isSafeInteger(verificationRunId) || verificationRunId < 1) throw Object.assign(new Error('verification_run_id must be a positive integer'), { code: 'INVALID_REQUEST', details: { field: 'verification_run_id' } });
  return Object.freeze({
    repo,
    candidate_sha: exactSha(input.candidate_sha, 'candidate_sha'),
    observed_development_head: exactSha(input.observed_development_head, 'observed_development_head'),
    observed_production_head: exactSha(input.observed_production_head, 'observed_production_head'),
    verification_run_id: verificationRunId,
    idempotency_key: requiredString(input.idempotency_key, 'idempotency_key', 200),
  });
}

function normalizeRoles(roles) {
  if (!roles || roles.development_branch !== 'dev' || typeof roles.production_branch !== 'string' || !roles.production_branch || roles.production_branch === 'dev') {
    return null;
  }
  return { development_branch: 'dev', production_branch: roles.production_branch };
}

function validVerification(run, normalized, roles) {
  return Number(run?.id) === normalized.verification_run_id
    && String(run?.path || '') === WORKFLOW_PATH
    && String(run?.event || '') === 'push'
    && String(run?.head_branch || '') === roles.development_branch
    && String(run?.head_sha || '').toLowerCase() === normalized.candidate_sha
    && String(run?.status || '') === 'completed'
    && String(run?.conclusion || '') === 'success';
}

function promotionReceipt(normalized, roles, run, { changed, replay = false, recovered = false }) {
  return {
    ok: true,
    repo: normalized.repo,
    development_branch: roles.development_branch,
    production_branch: roles.production_branch,
    development_head: normalized.candidate_sha,
    old_production_head: normalized.observed_production_head,
    new_production_head: normalized.candidate_sha,
    verification_run_id: normalized.verification_run_id,
    verification_workflow: WORKFLOW_PATH,
    verification_url: run?.html_url ? String(run.html_url) : null,
    changed: Boolean(changed),
    verified: true,
    idempotency_key: normalized.idempotency_key,
    idempotent_replay: Boolean(replay),
    recovered_after_uncertain_mutation: Boolean(recovered),
    may_have_mutated: false,
  };
}

async function requestDigest(normalized) {
  const { idempotency_key: ignored, ...semantic } = normalized;
  return sha256Text(canonicalJson(semantic));
}

async function rejectBeforeMutation(store, normalized, attemptToken, result) {
  if (store && attemptToken && typeof store.abandon === 'function') await store.abandon(normalized, attemptToken);
  return result;
}

export async function promoteGithubProduction(input, options = {}) {
  let normalized;
  try { normalized = normalizeGithubProductionPromotionRequest(input); }
  catch (error) { return failure(error.code || 'INVALID_REQUEST', error.message, error.details || {}, false); }
  const roles = normalizeRoles(options.branchRoles);
  if (!roles) return failure('GITHUB_PRODUCTION_PROMOTION_BRANCH_ROLES_REQUIRED', 'repository must have distinct dev and production branch roles before promotion', {}, false);
  const github = options.github;
  if (!github || ['getBranch','compare','getWorkflowRun','updateBranch'].some(name => typeof github[name] !== 'function')) {
    return failure('GITHUB_PRODUCTION_PROMOTION_TRANSPORT_UNAVAILABLE', 'promotion GitHub adapter is incomplete', {}, false);
  }

  const digest = await requestDigest(normalized);
  const store = options.receipts || null;
  let claim = null;
  if (store) {
    claim = await store.claim(normalized, digest);
    if (claim.kind === 'conflict') return failure('IDEMPOTENCY_CONFLICT', 'idempotency key is already bound to a different production promotion', { idempotency_key: normalized.idempotency_key }, false);
    if (claim.kind === 'in_progress') return failure('IDEMPOTENCY_IN_PROGRESS', 'the same production promotion is already in progress', { idempotency_key: normalized.idempotency_key }, false);
    if (claim.kind === 'existing') return { ...(claim.row.receipt || {}), idempotent_replay: true, may_have_mutated: false };
  }
  const attemptToken = claim?.attempt_token || null;

  const dev = await github.getBranch(normalized.repo, roles.development_branch);
  const prod = await github.getBranch(normalized.repo, roles.production_branch);
  if (!dev?.sha || !prod?.sha) return rejectBeforeMutation(store, normalized, attemptToken, failure('GITHUB_PRODUCTION_PROMOTION_STATE_UNAVAILABLE', 'development or production branch could not be observed', {}, false));
  const devSha = String(dev.sha).toLowerCase();
  const prodSha = String(prod.sha).toLowerCase();

  if (devSha !== normalized.observed_development_head) {
    return rejectBeforeMutation(store, normalized, attemptToken, failure('GITHUB_PRODUCTION_PROMOTION_STATE_CHANGED', 'development branch moved after observation', { expected_head: normalized.observed_development_head, actual_head: devSha, branch: roles.development_branch }, false));
  }
  if (normalized.candidate_sha !== devSha) {
    return rejectBeforeMutation(store, normalized, attemptToken, failure('GITHUB_PRODUCTION_PROMOTION_CANDIDATE_CHANGED', 'candidate must be the exact current dev head', { candidate_sha: normalized.candidate_sha, development_head: devSha }, false));
  }

  const run = await github.getWorkflowRun(normalized.repo, normalized.verification_run_id);
  if (!validVerification(run, normalized, roles)) {
    return rejectBeforeMutation(store, normalized, attemptToken, failure('GITHUB_PRODUCTION_PROMOTION_VERIFICATION_REQUIRED', 'candidate does not have successful exact-revision V8 verification from a dev push', {
      candidate_sha: normalized.candidate_sha,
      verification_run_id: normalized.verification_run_id,
      observed_event: run?.event || null,
      observed_head_branch: run?.head_branch || null,
      observed_head_sha: run?.head_sha || null,
      observed_status: run?.status || null,
      observed_conclusion: run?.conclusion || null,
    }, false));
  }

  if (prodSha === normalized.candidate_sha) {
    const receipt = promotionReceipt(normalized, roles, run, { changed: false, replay: Boolean(claim?.resumed), recovered: Boolean(claim?.resumed && normalized.observed_production_head !== prodSha) });
    if (store && attemptToken) await store.succeed(normalized, attemptToken, receipt);
    return receipt;
  }
  if (prodSha !== normalized.observed_production_head) {
    return rejectBeforeMutation(store, normalized, attemptToken, failure('GITHUB_PRODUCTION_PROMOTION_STATE_CHANGED', 'production branch moved after observation', { expected_head: normalized.observed_production_head, actual_head: prodSha, branch: roles.production_branch }, false));
  }

  const comparison = await github.compare(normalized.repo, prodSha, normalized.candidate_sha);
  if (!['ahead','identical'].includes(String(comparison?.status || ''))) {
    return rejectBeforeMutation(store, normalized, attemptToken, failure('GITHUB_PRODUCTION_PROMOTION_NON_FAST_FORWARD', 'candidate is not a fast-forward descendant of production', { production_head: prodSha, candidate_sha: normalized.candidate_sha, comparison_status: comparison?.status || null }, false));
  }

  const preDev = await github.getBranch(normalized.repo, roles.development_branch);
  const preProd = await github.getBranch(normalized.repo, roles.production_branch);
  if (String(preDev?.sha || '').toLowerCase() !== normalized.candidate_sha || String(preProd?.sha || '').toLowerCase() !== prodSha) {
    return rejectBeforeMutation(store, normalized, attemptToken, failure('GITHUB_PRODUCTION_PROMOTION_STATE_CHANGED', 'branch coordinates changed immediately before promotion', { expected_development_head: normalized.candidate_sha, actual_development_head: preDev?.sha || null, expected_production_head: prodSha, actual_production_head: preProd?.sha || null }, false));
  }

  let updateError = null;
  try { await github.updateBranch(normalized.repo, roles.production_branch, normalized.candidate_sha); }
  catch (error) { updateError = error; }
  let after;
  try { after = await github.getBranch(normalized.repo, roles.production_branch); }
  catch (error) { throw errorAfterMutationBoundary(error, 'possible'); }
  const afterSha = String(after?.sha || '').toLowerCase();
  if (afterSha !== normalized.candidate_sha) {
    const result = failure('GITHUB_PRODUCTION_PROMOTION_INDETERMINATE', 'production ref update was not proven by authoritative readback', {
      production_branch: roles.production_branch,
      intended_head: normalized.candidate_sha,
      observed_head: afterSha || null,
      upstream_error: updateError ? String(updateError?.message || updateError) : null,
    }, true);
    return result;
  }

  const receipt = promotionReceipt(normalized, roles, run, { changed: true, recovered: Boolean(updateError) });
  if (store && attemptToken) {
    try { await store.succeed(normalized, attemptToken, receipt); }
    catch (error) { throw errorAfterMutationBoundary(error, 'confirmed'); }
  }
  return receipt;
}

export function createGithubProductionPromotionReceiptStore(dbBinding) {
  return {
    async claim(normalized, digest) {
      const attemptToken = crypto.randomUUID();
      const inserted = await dbBinding.query(
        `INSERT INTO github_production_promotion_receipts
           (repo,idempotency_key,request_sha256,request_json,state,attempt_token,candidate_sha,old_production_head,verification_run_id)
         VALUES ($1,$2,$3,$4::jsonb,'processing',$5::uuid,$6,$7,$8)
         ON CONFLICT (repo,idempotency_key) DO NOTHING
         RETURNING *`,
        [normalized.repo, normalized.idempotency_key, digest, canonicalJson(normalized), attemptToken, normalized.candidate_sha, normalized.observed_production_head, normalized.verification_run_id],
      );
      if (inserted.rows?.[0]) return { kind: 'claimed', row: inserted.rows[0], attempt_token: attemptToken };
      const current = (await dbBinding.query('SELECT * FROM github_production_promotion_receipts WHERE repo=$1 AND idempotency_key=$2 LIMIT 1', [normalized.repo, normalized.idempotency_key])).rows?.[0];
      if (!current) throw Object.assign(new Error('promotion receipt disappeared during claim'), { code: 'IDEMPOTENCY_UNAVAILABLE' });
      if (current.request_sha256 !== digest) return { kind: 'conflict', row: current };
      if (current.state === 'succeeded') return { kind: 'existing', row: current };
      const takeover = await dbBinding.query(
        `UPDATE github_production_promotion_receipts SET attempt_token=$3::uuid,updated_at=now()
          WHERE repo=$1 AND idempotency_key=$2 AND state='processing' AND updated_at < now() - interval '30 seconds'
          RETURNING *`,
        [normalized.repo, normalized.idempotency_key, attemptToken],
      );
      if (takeover.rows?.[0]) return { kind: 'claimed', row: takeover.rows[0], attempt_token: attemptToken, resumed: true };
      return { kind: 'in_progress', row: current };
    },
    async abandon(normalized, attemptToken) {
      await dbBinding.query(
        `DELETE FROM github_production_promotion_receipts WHERE repo=$1 AND idempotency_key=$2 AND attempt_token=$3::uuid AND state='processing'`,
        [normalized.repo, normalized.idempotency_key, attemptToken],
      );
    },
    async succeed(normalized, attemptToken, receipt) {
      await dbBinding.query(
        `UPDATE github_production_promotion_receipts
            SET state='succeeded',new_production_head=$4,receipt=$5::jsonb,last_error=NULL,updated_at=now()
          WHERE repo=$1 AND idempotency_key=$2 AND attempt_token=$3::uuid`,
        [normalized.repo, normalized.idempotency_key, attemptToken, receipt.new_production_head, canonicalJson(receipt)],
      );
    },
  };
}