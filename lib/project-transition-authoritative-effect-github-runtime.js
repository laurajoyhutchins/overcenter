import { createPostgresExecutionAuthorityService } from './execution-authority.js';
import { executeBoundProviderEffect } from './execution-provider-wrapper.js';
import { createGithubPullRequestRoleAware, reconcileGithubIntegrationRoleAware } from './github-branch-role-runtime.js';
import { deriveProjectTransitionGithubWorkspace } from './project-transition-github-workspace.js';
import { resolveRepositoryBranchRoles } from './repository-branch-roles.js';
import { projectTransitionAuthoritativeEffectConfirmationFor } from './project-transition-authoritative-effect.js';
import { projectTransitionPullRequestDetailNumbers, projectTransitionPullRequestReadQuery } from './project-transition-authoritative-effect-github-query.js';

function fail(code, message, details = null) {
  throw Object.assign(new Error(message), { code, details });
}

function responseBody(response, phase) {
  const status = Number(response?.status || 0);
  if (status < 200 || status >= 300) {
    fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_GITHUB_READ_FAILED', `GitHub authoritative read failed during ${phase}`, {
      phase,
      upstream_status:status || null,
      may_have_mutated:false,
    });
  }
  return response?.body;
}

async function readActiveProjectTransitionLease(db, runId, observedAt = new Date().toISOString()) {
  if (!db || typeof db.query !== 'function') fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_RUNTIME_INVALID', 'database binding is required');
  const result = await db.query(
    `SELECT e.lease_ref::text AS lease_ref, e.run_id, e.lease_epoch, e.expires_at
       FROM execution_state e
      WHERE e.run_id=$1
        AND e.subject_kind='project_transition'
        AND e.lifecycle='executing'
        AND e.settled=false
        AND e.lease_ref IS NOT NULL
        AND e.expires_at > $2::timestamptz
      ORDER BY e.updated_at DESC, e.lease_ref DESC
      LIMIT 2`,
    [runId, observedAt],
  );
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  if (rows.length > 1) {
    const error = new Error('multiple active project transition leases exist for the orchestration run');
    error.code = 'PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_LEASE_AMBIGUOUS';
    error.may_have_mutated = false;
    error.details = Object.freeze({ run_id:runId, active_lease_count:rows.length, may_have_mutated:false });
    throw error;
  }
  return rows[0] || null;
}

export async function resolveActiveProjectTransitionLeaseRef(db, runId, observedAt = new Date().toISOString()) {
  if (!db || typeof db.query !== 'function') fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_RUNTIME_INVALID', 'database binding is required');
  const result = await db.query(
    `SELECT e.lease_ref::text AS lease_ref
       FROM execution_state e
      WHERE e.run_id=$1
        AND e.subject_kind='project_transition'
        AND e.lifecycle='executing'
        AND e.settled=false
        AND e.lease_ref IS NOT NULL
        AND e.expires_at > $2::timestamptz
      ORDER BY e.updated_at DESC, e.lease_ref DESC
      LIMIT 2`,
    [runId, observedAt],
  );
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  if (rows.length > 1) {
    const error = new Error('multiple active project transition leases exist for the orchestration run');
    error.code = 'PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_LEASE_AMBIGUOUS';
    error.may_have_mutated = false;
    error.details = Object.freeze({ run_id:runId, active_lease_count:rows.length, may_have_mutated:false });
    throw error;
  }
  return rows[0]?.lease_ref || null;
}

function authoritativeEffectRef(result) {
  const entry = Array.isArray(result?.evidence)
    ? result.evidence.find((item) => String(item?.kind || '').trim() === 'authoritative_effect')
    : null;
  return typeof entry?.ref === 'string' && entry.ref.trim() ? entry.ref.trim() : null;
}

function invocationFacts(result) {
  const effectRef = authoritativeEffectRef(result);
  if (result?.confirmed === true && effectRef) {
    return {
      transport:'accepted',
      committed:true,
      effect_ref:effectRef,
      response_sha256:null,
      evidence:{ confirmation:result },
    };
  }
  return {
    transport:'unknown',
    committed:null,
    effect_ref:null,
    response_sha256:null,
    evidence:{ confirmation:result || null },
  };
}

function confirmationFacts(result) {
  const effectRef = authoritativeEffectRef(result);
  if (result?.confirmed === true && effectRef) {
    return {
      status:'confirmed',
      effect_ref:effectRef,
      predicate:'project-transition-authoritative-effect-readback',
      evidence:{ confirmation:result },
    };
  }
  if (result?.reason === 'authoritative_effect_not_observed') {
    return {
      status:'unknown',
      effect_ref:null,
      predicate:'project-transition-authoritative-effect-readback',
      evidence:{ confirmation:result || null },
    };
  }
  return {
    status:'unknown',
    effect_ref:null,
    predicate:'project-transition-authoritative-effect-readback',
    evidence:{ confirmation:result || null },
  };
}

function kernelAuthority(authority) {
  return {
    project_ref:String(authority?.project_ref || ''),
    repository:String(authority?.authority?.repository || authority?.repository || ''),
    authority_revision:String(authority?.authority?.revision || '').toLowerCase(),
    authority_epoch:Number(authority?.authority_epoch),
    graph_fingerprint:String(authority?.graph_fingerprint || ''),
    transition_fingerprint:String(authority?.transition_definition_fingerprint || ''),
  };
}

export function createPostgresProjectTransitionAuthoritativeEffectConfirmationService(options = {}) {
  const db = options.db;
  if (!db || typeof db.query !== 'function') fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_RUNTIME_INVALID', 'database binding is required');
  const withApp = options.withGitHubAppApiClient;
  if (typeof withApp !== 'function') fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_RUNTIME_INVALID', 'GitHub auth provider is required');
  const executionAuthority = options.executionAuthority || createPostgresExecutionAuthorityService({
    db,
    api:options.api,
    withGitHubAppApiClient:withApp,
  });

  async function githubRead(repository, permissionProfile, path, query = undefined) {
    return withApp(repository, async (client) => {
      const response = await client.call('github', { path, ...(query ? { query } : {}) });
      return responseBody(response, path);
    }, { permissionProfile });
  }

  const confirmation = projectTransitionAuthoritativeEffectConfirmationFor({
    async readLeaseRef(runId) {
      return resolveActiveProjectTransitionLeaseRef(db, runId);
    },
    executionAuthority,
    async readHistoricalAuthorities({ project_ref, transition_id, transition_definition_fingerprint }) {
      const result = await db.query(
        `SELECT e.lease_ref::text AS lease_id, e.run_id,
                e.authority_repository, e.authority_revision, e.authority_derivation,
                e.project_ref, e.transition_id, e.transition_definition_fingerprint,
                e.settlement_receipt, NULL::jsonb AS claim_receipt
           FROM execution_state e
          WHERE e.subject_kind='project_transition'
            AND e.lifecycle='settled'
            AND e.settled=true
            AND e.project_ref=$1
            AND e.transition_id=$2
            AND e.transition_definition_fingerprint=$3
         UNION ALL
         SELECT l.lease_id::text AS lease_id, l.run_id,
                NULL::text, NULL::text, NULL::text,
                NULL::text, NULL::text, NULL::text,
                NULL::jsonb AS settlement_receipt, l.claim_receipt
           FROM work_leases l
          WHERE l.claim_receipt->>'subject'='project_transition'
            AND l.claim_receipt->'project_transition'->>'project_ref'=$1
            AND l.claim_receipt->'project_transition'->>'transition_id'=$2
            AND l.claim_receipt->'project_transition'->>'transition_definition_fingerprint'=$3
            AND NOT EXISTS (
              SELECT 1
                FROM execution_state e
               WHERE e.subject_kind='project_transition'
                 AND e.lease_ref=l.lease_id
                 AND e.settled=true
            )
          ORDER BY lease_id DESC
          LIMIT 32`,
        [project_ref, transition_id, transition_definition_fingerprint],
      );
      return (result.rows || []).map((row) => {
        let canonicalReceipt = row.settlement_receipt;
        let projectionReceipt = row.claim_receipt;
        if (typeof canonicalReceipt === 'string') {
          try { canonicalReceipt = JSON.parse(canonicalReceipt); } catch { canonicalReceipt = null; }
        }
        if (typeof projectionReceipt === 'string') {
          try { projectionReceipt = JSON.parse(projectionReceipt); } catch { projectionReceipt = null; }
        }
        const subject = canonicalReceipt?.project_transition || projectionReceipt?.project_transition;
        if (!subject) return null;
        return Object.freeze({
          subject:'project_transition',
          lease_ref:String(row.lease_id || ''),
          run_id:String(row.run_id || ''),
          repository:String(subject.repository || row.authority_repository || ''),
          project_ref:String(subject.project_ref || row.project_ref || ''),
          transition_id:String(subject.transition_id || row.transition_id || ''),
          transition_definition_fingerprint:String(subject.transition_definition_fingerprint || row.transition_definition_fingerprint || ''),
          authority:Object.freeze({
            kind:'github',
            repository:String(subject.repository || row.authority_repository || ''),
            revision:String(subject.authority_revision || row.authority_revision || '').toLowerCase(),
            derivation:String(subject.authority_derivation || row.authority_derivation || ''),
          }),
        });
      }).filter(Boolean);
    },
    deriveWorkspace:deriveProjectTransitionGithubWorkspace,
    resolveBranchRoles:(repository) => resolveRepositoryBranchRoles(repository, { db }),
    async readPullRequests({ repository, head, base }) {
      const [owner, name] = repository.split('/');
      const listPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`;
      const pulls = await githubRead(repository, 'review_packet', listPath, projectTransitionPullRequestReadQuery({ base }));
      if (!Array.isArray(pulls)) return pulls;
      const detailNumbers = projectTransitionPullRequestDetailNumbers({ pulls, head });
      if (!detailNumbers.length) return pulls;
      const details = new Map();
      for (const number of detailNumbers) {
        const detail = await githubRead(repository, 'review_packet', `${listPath}/${number}`);
        details.set(number, detail);
      }
      return pulls.map((pull) => details.get(Number(pull?.number)) || pull);
    },
    async readBranchHead({ repository, branch }) {
      const [owner, name] = repository.split('/');
      const body = await githubRead(repository, 'project_facts', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches/${encodeURIComponent(branch)}`);
      return body?.commit?.sha || null;
    },
    async compareCommits({ repository, base, head }) {
      const [owner, name] = repository.split('/');
      return githubRead(repository, 'project_facts', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    },
    async integrateCandidate({ repository, pull_request, workspace_branch, development_branch, expected_base, expected_head }) {
      let pullRequest = pull_request;
      if (!pullRequest) {
        const created = await createGithubPullRequestRoleAware({
          repo:repository,
          base:development_branch,
          head:workspace_branch,
          expected_base,
          expected_head,
          title:'project: integrate verified transition candidate',
          body:'Overcenter deterministic project-transition continuation. The candidate is bound to the exact verified head and authoritative base.',
          draft:false,
        }, { db, withGitHubAppApiClient:withApp });
        if (!created?.ok) return created;
        pullRequest = Number(created.pull_request);
      }
      return reconcileGithubIntegrationRoleAware({
        repo:repository,
        pull_request:pullRequest,
        expected_head,
        apply:true,
      }, { db, withGitHubAppApiClient:withApp });
    },
  });
  return Object.freeze({
    async confirm(request = {}) {
      const executionTransactionStore = options.executionTransactionStore;
      if (!executionTransactionStore || typeof executionTransactionStore.prepareExecution !== 'function') {
        fail('EXECUTION_TRANSACTION_STORE_REQUIRED', 'authoritative project-transition effects require the execution transaction store');
      }
      const activeLease = await readActiveProjectTransitionLease(db, request.run_id);
      if (!activeLease?.lease_ref) {
        fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_LEASE_NOT_FOUND', 'active execution lease was not found', { may_have_mutated:false });
      }
      const authority = await executionAuthority.require({ lease_ref:activeLease.lease_ref });
      if (authority.run_id !== request.run_id) {
        fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_AUTHORITY_MISMATCH', 'active project-transition lease belongs to another run', { may_have_mutated:false });
      }
      const transitionId = request?.target?.horizon?.kind === 'transition'
        ? String(request.target.horizon.ref || '').trim()
        : '';
      if (!transitionId) {
        fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_AUTHORITY_INVALID', 'authoritative effects require a transition target', { may_have_mutated:false });
      }
      const candidateRequest = Object.freeze({
        project_ref:authority.project_ref,
        subject_key:`${authority.project_ref}:transition:${transitionId}:authoritative-effect`,
        target:request.target,
        execution_result:request.execution_result,
      });
      const kernelAuthorityValue = kernelAuthority(authority);
      const transaction = await executeBoundProviderEffect({
        subject_kind:'project_transition',
        operation_kind:'project_transition.authoritative_effect',
        request:candidateRequest,
        authority:kernelAuthorityValue,
        idempotency_scope:`project-transition:${authority.project_ref}:${transitionId}`,
        payload:{
          target:request.target,
          execution_result:request.execution_result,
        },
        ports:{
          executionTransactionStore,
          executionContext() {
            return {
              run_id:String(activeLease.run_id || request.run_id),
              subject_kind:'provider_operation',
              lease_epoch:Number(activeLease.lease_epoch),
              authority_epoch:Number(authority.authority_epoch),
              lease_expires_at:String(activeLease.expires_at),
            };
          },
          providerFor() {
            return {
              async preflight() {
                const fresh = await executionAuthority.require({ lease_ref:activeLease.lease_ref });
                return {
                  provider:'github',
                  observed_revision:String(fresh.authority?.revision || ''),
                  provider_identity:{
                    authority_epoch:fresh.authority_epoch,
                    repository:fresh.repository,
                    transition_id:fresh.transition_id,
                  },
                };
              },
              async invoke() {
                return invocationFacts(await confirmation.confirm({
                  ...candidateRequest,
                  run_id:String(activeLease.run_id || request.run_id),
                }, { allowIntegration:true }));
              },
              async confirm() {
                return confirmationFacts(await confirmation.confirm({
                  ...candidateRequest,
                  run_id:String(activeLease.run_id || request.run_id),
                }, { allowIntegration:false }));
              },
            };
          },
        },
      });
      if (transaction.receipt.disposition === 'completed') {
        const effectRef = transaction.receipt.effect_ref || `execution-proof:${transaction.receipt.evidence_sha256}`;
        return Object.freeze({
          confirmed:true,
          evidence:Object.freeze([{ kind:'authoritative_effect', ref:effectRef }]),
          execution_id:transaction.identity.execution_id,
          settlement_receipt:transaction.receipt,
        });
      }
      if (transaction.receipt.disposition === 'no_effect') {
        return Object.freeze({
          confirmed:false,
          reason:'authoritative_effect_not_observed',
          execution_id:transaction.identity.execution_id,
          settlement_receipt:transaction.receipt,
        });
      }
      return Object.freeze({
        confirmed:false,
        reason:'authoritative_effect_uncertain',
        execution_id:transaction.identity.execution_id,
        settlement_receipt:transaction.receipt,
      });
    },
  });
}
