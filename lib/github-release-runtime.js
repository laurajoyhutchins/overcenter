// Runtime database and GitHub auth are injected by the composition root.
import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
import { executeGithubRelease } from 'lib/github-release-execution.js';
import {
  createGithubRelease,
  normalizeGithubReleaseRequest,
  observeGithubRelease,
  classifyGithubRelease,
} from 'lib/github-release.js';

function fail(error, message, details = {}) {
  return { ok: false, error, message, details, may_have_mutated: false };
}

function semanticInput(input) {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'run_id'))
    : input;
}

function normalizeInput(input) {
  try {
    return normalizeGithubReleaseRequest(semanticInput(input));
  } catch (error) {
    return fail(error.code || 'INVALID_REQUEST', error.message, error.details || {});
  }
}

export async function observeGithubReleaseWithGitHubApp(input, options = {}) {
  const normalized = normalizeInput(input);
  if (normalized?.ok === false) return normalized;
  const withGitHubAppApiClient = options.withGitHubAppApiClient;
  if (typeof withGitHubAppApiClient !== 'function') {
    return fail('RUNTIME_PROVIDER_MISSING', 'release runtime requires explicit GitHub App auth provider');
  }
  return withGitHubAppApiClient(
    normalized.repo,
    async (apiClient) => {
      const observed = await observeGithubRelease(apiClient, normalized);
      if (observed?.ok !== true) return observed;
      return {
        ...observed,
        classification:classifyGithubRelease(observed, normalized),
      };
    },
    { permissionProfile:'release' },
  );
}

function effectRef(normalized, result = null) {
  const releaseId = Number(result?.release_id);
  return `github-release:${normalized.repo}#${normalized.tag_name}@${normalized.target_sha}${Number.isSafeInteger(releaseId) && releaseId > 0 ? `:release:${releaseId}` : ''}`;
}

async function invocationFacts(normalized, result) {
  const evidence = result && typeof result === 'object' ? result : { result:String(result) };
  const response_sha256 = await sha256Text(canonicalJson(evidence));
  if (result?.ok === true && result.verified === true) {
    return {
      transport:'accepted',
      committed:true,
      effect_ref:effectRef(normalized, result),
      response_sha256,
      evidence,
    };
  }
  if (result?.may_have_mutated === true) {
    return {
      transport:'unknown',
      committed:null,
      effect_ref:null,
      response_sha256:null,
      evidence,
    };
  }
  return {
    transport:'rejected',
    committed:false,
    effect_ref:null,
    response_sha256,
    evidence,
  };
}

function confirmationFacts(normalized, observed) {
  if (observed?.ok !== true) {
    return {
      status:'unknown',
      effect_ref:null,
      predicate:'github-release-readback',
      evidence:{ observed },
    };
  }
  if (observed.classification === 'satisfied') {
    return {
      status:'confirmed',
      effect_ref:effectRef(normalized, observed.release),
      predicate:'github-release-tag-and-release-match',
      evidence:{
        classification:observed.classification,
        verified_commit_sha:observed.verified_commit_sha,
        tag_commit_sha:observed.tag_commit_sha,
        release_id:observed.release?.id || null,
        release_url:observed.release?.html_url || null,
      },
    };
  }
  if (observed.classification === 'absent') {
    return {
      status:'absent',
      effect_ref:null,
      predicate:'github-release-tag-and-release-absent',
      evidence:{
        classification:observed.classification,
        verified_commit_sha:observed.verified_commit_sha,
      },
    };
  }
  return {
    status:'unknown',
    effect_ref:null,
    predicate:'github-release-readback',
    evidence:{
      classification:observed.classification || null,
      verified_commit_sha:observed.verified_commit_sha || null,
      tag_commit_sha:observed.tag_commit_sha || null,
      release_id:observed.release?.id || null,
    },
  };
}

function replayResult(normalized, observed) {
  const releaseId = Number(observed?.release?.id);
  const releaseUrl = typeof observed?.release?.html_url === 'string' ? observed.release.html_url : '';
  if (observed?.ok !== true || observed.classification !== 'satisfied'
      || !Number.isSafeInteger(releaseId) || releaseId < 1 || !releaseUrl) {
    return fail('RELEASE_REPLAY_UNPROVEN', 'settled release execution could not be reconstructed from exact provider readback', {
      classification:observed?.classification || null,
      release_id:Number.isSafeInteger(releaseId) ? releaseId : null,
    });
  }
  return {
    ok:true,
    repo:normalized.repo,
    requested_commit_sha:normalized.target_sha,
    verified_commit_sha:observed.tag_commit_sha,
    tag_name:normalized.tag_name,
    tag_ref:observed.tag?.ref || `refs/tags/${normalized.tag_name}`,
    release_id:releaseId,
    release_url:releaseUrl,
    post_state:'satisfied',
    verified:true,
    verification_result:'verified',
    idempotency_key:normalized.idempotency_key,
    idempotent_replay:true,
    may_have_mutated:false,
  };
}

export async function createGithubReleaseWithExecutionKernel(input, options = {}) {
  const normalized = normalizeInput(input);
  if (normalized?.ok === false) return normalized;
  const db = options.db;
  const withGitHubAppApiClient = options.withGitHubAppApiClient;
  const executionTransactionStore = options.executionTransactionStore;
  if (!db || typeof db.query !== 'function' || typeof withGitHubAppApiClient !== 'function') {
    return fail('RUNTIME_PROVIDER_MISSING', 'release runtime requires explicit database and GitHub App auth providers');
  }
  if (!executionTransactionStore || typeof executionTransactionStore.prepareExecution !== 'function') {
    return fail('EXECUTION_TRANSACTION_STORE_REQUIRED', 'release execution requires the authoritative execution transaction store');
  }
  const authorityEpoch = Number(options.authority_epoch ?? options.authorityEpoch ?? 0);
  if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch < 0) {
    return fail('EXECUTION_AUTHORITY_EPOCH_INVALID', 'release execution authority epoch is invalid');
  }
  const runId = String(
    options.run_id
      || options.runId
      || `github-release:${normalized.idempotency_key}:${crypto.randomUUID()}`,
  );
  let invokedResult = null;
  const transaction = await executeGithubRelease({
    project_ref:`github:${normalized.repo}`,
    subject_key:`github:${normalized.repo}:release:${normalized.tag_name}`,
    repository:normalized.repo,
    authority_revision:normalized.target_sha,
    authority_epoch:authorityEpoch,
    graph_fingerprint:`github-release-target:${normalized.repo}@${normalized.target_sha}`,
    transition_fingerprint:`github-release-request:${normalized.idempotency_key}`,
    repo:normalized.repo,
    target_revision:normalized.target_sha,
    tag_name:normalized.tag_name,
    body:normalized.body,
    name:normalized.name,
    draft:normalized.draft,
    prerelease:normalized.prerelease,
    expected_state:normalized.expected_state,
    idempotency_key:normalized.idempotency_key,
  }, {
    executionTransactionStore,
    executionContext() {
      return {
        run_id:runId,
        subject_kind:'provider_operation',
        authority_epoch:authorityEpoch,
        lease_expires_at:new Date(Date.now() + 60_000).toISOString(),
      };
    },
    providerFor() {
      return {
        async preflight() {
          let observed;
          try {
            observed = await observeGithubReleaseWithGitHubApp(normalized, { withGitHubAppApiClient });
          } catch (error) {
            observed = { ok:false, error:String(error?.message || error) };
          }
          if (observed?.ok !== true
              || String(observed.verified_commit_sha || '').toLowerCase() !== normalized.target_sha) {
            return {
              provider:'github',
              observed_revision:`release-observation:${String(observed?.verified_commit_sha || observed?.error || 'unavailable')}`,
              provider_identity:{ observed },
            };
          }
          return {
            provider:'github',
            observed_revision:normalized.target_sha,
            provider_identity:{
              verified_commit_sha:observed.verified_commit_sha,
              tag_commit_sha:observed.tag_commit_sha || null,
              classification:observed.classification || null,
            },
          };
        },
        async invoke() {
          invokedResult = await createGithubReleaseWithGitHubApp(normalized, {
            db,
            withGitHubAppApiClient,
            receiptStore:null,
          });
          return invocationFacts(normalized, invokedResult);
        },
        async confirm() {
          try {
            return confirmationFacts(
              normalized,
              await observeGithubReleaseWithGitHubApp(normalized, { withGitHubAppApiClient }),
            );
          } catch (error) {
            return {
              status:'unknown',
              effect_ref:null,
              predicate:'github-release-readback',
              evidence:{ error:String(error?.message || error) },
            };
          }
        },
      };
    },
  });
  if (transaction.receipt.disposition !== 'completed') {
    return fail('RELEASE_NOT_COMPLETED', 'release execution did not settle as completed', {
      disposition:transaction.receipt.disposition,
      execution_id:transaction.identity.execution_id,
    });
  }
  if (invokedResult) return { ...invokedResult, idempotent_replay:false };
  return replayResult(
    normalized,
    await observeGithubReleaseWithGitHubApp(normalized, { withGitHubAppApiClient }),
  );
}

export async function createGithubReleaseWithGitHubApp(input, options = {}) {
  const normalized = normalizeInput(input);
  if (normalized?.ok === false) return normalized;
  const db = options.db;
  const withGitHubAppApiClient = options.withGitHubAppApiClient;
  if (!db || typeof db.query !== 'function' || typeof withGitHubAppApiClient !== 'function') {
    return fail('RUNTIME_PROVIDER_MISSING', 'release runtime requires explicit database and GitHub App auth providers');
  }
  if (options.receiptStore === undefined) {
    return fail('EXECUTION_TRANSACTION_REQUIRED', 'direct GitHub release execution is disabled; use the execution transaction kernel');
  }
  return withGitHubAppApiClient(
    normalized.repo,
    (apiClient) => createGithubRelease(normalized, { apiClient, receiptStore:options.receiptStore }),
    { permissionProfile:'release' },
  );
}
