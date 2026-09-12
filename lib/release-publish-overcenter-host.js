// Database provider is injected by the runtime composition root.
import { canonicalJson, sha256Text } from './canonical-json.js';
import { executeGithubRelease } from './github-release-execution.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { canonicalProjectDefinition } from './project-authoring.js';
import { OVERCENTER_PROJECT_DEFINITION_PATH } from './overcenter-project-graph-deriver.js';
import {
  createGithubReleaseWithGitHubApp,
  observeGithubReleaseWithGitHubApp,
} from './github-release-runtime.js';
import { publishReleasePlan } from './release-publish-operation.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function exactDefinitionTransitions(envelope, projectRef, authority) {
  if (!envelope || envelope.schema !== 'project-authority-facts-v1'
      || envelope.repository !== authority.repository
      || String(envelope.revision || '').toLowerCase() !== authority.revision) {
    fail('RELEASE_PUBLISH_DEFINITION_FACTS_MISMATCH', 'release publication facts do not match exact plan authority');
  }
  const facts = envelope.facts?.definition_facts;
  if (!facts || facts.schema !== 'project-definition-facts-v1'
      || facts.repository !== authority.repository
      || String(facts.revision || '').toLowerCase() !== authority.revision) {
    fail('RELEASE_PUBLISH_DEFINITION_FACTS_MISMATCH', 'release publication definition facts are not attributable to exact authority');
  }
  const matches = (Array.isArray(facts.definitions) ? facts.definitions : [])
    .filter((entry) => entry?.path === OVERCENTER_PROJECT_DEFINITION_PATH);
  if (matches.length !== 1 || typeof matches[0]?.content !== 'string') {
    fail('RELEASE_PUBLISH_DEFINITION_UNAVAILABLE', 'exactly one repository-owned Overcenter project definition is required');
  }
  let parsed;
  try { parsed = JSON.parse(matches[0].content); }
  catch { fail('RELEASE_PUBLISH_DEFINITION_INVALID', 'repository-owned project definition must be valid JSON'); }
  const definition = canonicalProjectDefinition(parsed);
  if (definition.project_ref !== projectRef) {
    fail('RELEASE_PUBLISH_DEFINITION_SCOPE_MISMATCH', 'repository-owned project definition does not match release plan project');
  }
  return definition.transitions.map((transition) => Object.freeze({
    id:transition.id,
    ...(transition.version_impact ? { version_impact:transition.version_impact } : {}),
  }));
}

function authorityEpochFor(options, authority) {
  const value = Number(options.authorityEpoch ?? authority.authority_epoch ?? authority.epoch ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('RELEASE_PUBLISH_AUTHORITY_EPOCH_INVALID', 'release publication authority epoch is invalid', {
      authority_epoch:options.authorityEpoch ?? authority.authority_epoch ?? authority.epoch ?? null,
    });
  }
  return value;
}

function effectRef(request, result = null) {
  const releaseId = Number(result?.release_id);
  return `github-release:${request.repo}#${request.tag_name}@${request.target_sha}${Number.isSafeInteger(releaseId) && releaseId > 0 ? `:release:${releaseId}` : ''}`;
}

async function resultFacts(request, result) {
  const evidence = result && typeof result === 'object' ? result : { result:String(result) };
  const response_sha256 = await sha256Text(canonicalJson(evidence));
  if (result?.ok === true && result.verified === true) {
    return {
      transport:'accepted',
      committed:true,
      effect_ref:effectRef(request, result),
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

function unknownConfirmation(error) {
  return {
    status:'unknown',
    effect_ref:null,
    predicate:'github-release-readback',
    evidence:{ error:String(error?.message || error) },
  };
}

function confirmationFacts(request, observed) {
  if (observed?.status === 'confirmed' || observed?.status === 'absent' || observed?.status === 'unknown') {
    return {
      status:observed.status,
      effect_ref:observed.status === 'confirmed' ? effectRef(request, observed) : null,
      predicate:String(observed.predicate || 'github-release-readback'),
      evidence:observed.evidence && typeof observed.evidence === 'object' ? observed.evidence : { observed },
    };
  }
  if (observed?.ok !== true) return unknownConfirmation(observed);
  if (observed.classification === 'satisfied') {
    return {
      status:'confirmed',
      effect_ref:effectRef(request, observed.release),
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
      evidence:{ classification:observed.classification, verified_commit_sha:observed.verified_commit_sha },
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

function replayResult(request, observed) {
  const releaseId = Number(observed?.release?.id);
  const releaseUrl = typeof observed?.release?.html_url === 'string' ? observed.release.html_url : '';
  if (observed?.ok !== true || observed.classification !== 'satisfied'
      || !Number.isSafeInteger(releaseId) || releaseId < 1 || !releaseUrl) {
    fail('RELEASE_PUBLISH_REPLAY_UNPROVEN', 'settled release execution could not be reconstructed from exact provider readback', {
      classification:observed?.classification || null,
      release_id:Number.isSafeInteger(releaseId) ? releaseId : null,
    });
  }
  return {
    ok:true,
    repo:request.repo,
    requested_commit_sha:request.target_sha,
    verified_commit_sha:observed.tag_commit_sha,
    tag_name:request.tag_name,
    tag_ref:observed.tag?.ref || `refs/tags/${request.tag_name}`,
    release_id:releaseId,
    release_url:releaseUrl,
    post_state:'satisfied',
    verified:true,
    verification_result:'verified',
    idempotency_key:request.idempotency_key,
    idempotent_replay:true,
    may_have_mutated:false,
  };
}

async function executeReleaseWithKernel(request, authority, options, createRelease, observeRelease) {
  const executionTransactionStore = options.executionTransactionStore;
  if (!executionTransactionStore || typeof executionTransactionStore.prepareExecution !== 'function') {
    fail('EXECUTION_TRANSACTION_STORE_REQUIRED', 'release publication requires the authoritative execution transaction store');
  }
  const epoch = authorityEpochFor(options, authority);
  const projectRef = `github:${authority.repository}`;
  const runId = String(
    options.runId
      || options.run_id
      || `release:${request.idempotency_key}:${crypto.randomUUID()}`,
  );
  let invokedResult = null;
  const transaction = await executeGithubRelease({
    project_ref:projectRef,
    subject_key:`${projectRef}:release:${request.tag_name}`,
    repository:authority.repository,
    authority_revision:authority.revision,
    authority_epoch:epoch,
    graph_fingerprint:`github-project-graph:${authority.repository}@${authority.revision}#${authority.derivation}`,
    transition_fingerprint:`release-plan:${request.idempotency_key}`,
    repo:request.repo,
    target_revision:request.target_sha,
    tag_name:request.tag_name,
    body:request.body,
    name:request.name,
    draft:request.draft,
    prerelease:request.prerelease,
    expected_state:request.expected_state,
    idempotency_key:request.idempotency_key,
  }, {
    executionTransactionStore,
    executionContext() {
      return {
        run_id:runId,
        subject_kind:'provider_operation',
        authority_epoch:epoch,
        lease_expires_at:new Date(Date.now() + 60_000).toISOString(),
      };
    },
    providerFor() {
      return {
        async preflight() {
          let observed;
          try { observed = await observeRelease(request); }
          catch (error) { observed = { ok:false, error:String(error?.message || error) }; }
          if (observed?.ok !== true || String(observed.verified_commit_sha || '').toLowerCase() !== authority.revision) {
            return {
              provider:'github',
              observed_revision:`release-observation:${String(observed?.verified_commit_sha || observed?.error || 'unavailable')}`,
              provider_identity:{ observed },
            };
          }
          return {
            provider:'github',
            observed_revision:authority.revision,
            provider_identity:{
              verified_commit_sha:observed.verified_commit_sha,
              tag_commit_sha:observed.tag_commit_sha || null,
              classification:observed.classification || null,
            },
          };
        },
        async invoke() {
          invokedResult = await createRelease(request);
          return resultFacts(request, invokedResult);
        },
        async confirm() {
          try {
            return confirmationFacts(request, await observeRelease(request));
          } catch (error) {
            return unknownConfirmation(error);
          }
        },
      };
    },
  });
  if (transaction.receipt.disposition !== 'completed') {
    fail('RELEASE_PUBLISH_NOT_COMPLETED', 'release execution did not settle as completed', {
      disposition:transaction.receipt.disposition,
      execution_id:transaction.identity.execution_id,
    });
  }
  if (invokedResult) return { ...invokedResult, idempotent_replay:false };
  return replayResult(request, await observeRelease(request));
}

export function releasePublishingFor(options = {}) {
  const db = options.db;
  const withGitHubAppApiClient = options.withGitHubAppApiClient;
  const executionTransactionStore = options.executionTransactionStore;
  if (!executionTransactionStore || typeof executionTransactionStore.prepareExecution !== 'function') {
    fail('EXECUTION_TRANSACTION_STORE_REQUIRED', 'release publication requires the authoritative execution transaction store');
  }
  const graphRuntime = options.graphRuntime || createGitHubProjectGraphRuntime({ db, withGitHubAppApiClient });
  const createRelease = options.createRelease
    || ((request) => createGithubReleaseWithGitHubApp(request, {
      db,
      withGitHubAppApiClient,
      receiptStore:null,
    }));
  const observeRelease = options.observeRelease
    || ((request) => observeGithubReleaseWithGitHubApp(request, { withGitHubAppApiClient }));
  const readTransitions = options.readTransitions || (async ({ project_ref, authority }) => {
    const facts = await graphRuntime.readProjectFacts({
      project_ref,
      repository:authority.repository,
      revision:authority.revision,
    });
    return exactDefinitionTransitions(facts, project_ref, authority);
  });
  return Object.freeze({
    async publish(input) {
      return publishReleasePlan(input, {
        resolveAuthority:({ project_ref }) => graphRuntime.resolveProjectAuthority({ project_ref }),
        readTransitions,
        createRelease:(request) => executeReleaseWithKernel(
          request,
          currentAuthorityFor(input),
          options,
          createRelease,
          observeRelease,
        ),
      });
    },
  });

  function currentAuthorityFor(input) {
    const planAuthority = input?.plan?.authority;
    const repository = String(planAuthority?.repository || '').trim();
    const revision = String(planAuthority?.revision || '').trim().toLowerCase();
    const derivation = String(planAuthority?.derivation || '').trim();
    if (!repository || !revision || !derivation) {
      fail('RELEASE_PUBLISH_INVALID', 'release plan authority is required before execution');
    }
    return { repository, revision, derivation };
  }
}
