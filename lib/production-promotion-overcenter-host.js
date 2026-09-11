import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
import { createGithubProductionPromotionCapability } from 'lib/github-production-promotion-capability.js';
import { promoteProduction } from 'lib/production-promotion-operation.js';
import { resolveRepositoryBranchRoles } from 'lib/repository-branch-roles.js';

const SHA40 = /^[0-9a-f]{40}$/;

function strictVerificationRunId(verificationRef) {
  const runId = Number(String(verificationRef || '').replace(/^github-actions-run:/, ''));
  if (!Number.isSafeInteger(runId) || runId < 1) {
    throw Object.assign(new Error('PRODUCTION_PROMOTION_VERIFICATION_EVIDENCE_INVALID'), {
      code:'PRODUCTION_PROMOTION_VERIFICATION_EVIDENCE_INVALID',
      may_have_mutated:false,
    });
  }
  return runId;
}

function effectRef(request, roles) {
  return `github:${request.repo}#${roles.production}@${request.source_revision}`;
}

async function responseHash(evidence) {
  return sha256Text(canonicalJson(evidence));
}

function rejected(evidence) {
  return Promise.resolve(responseHash(evidence)).then((response_sha256) => ({
    transport:'rejected',
    committed:false,
    effect_ref:null,
    response_sha256,
    evidence,
  }));
}

function accepted(request, roles, evidence) {
  return responseHash(evidence).then((response_sha256) => ({
    transport:'accepted',
    committed:true,
    effect_ref:effectRef(request, roles),
    response_sha256,
    evidence,
  }));
}

function unknown(evidence) {
  return {
    transport:'unknown',
    committed:null,
    effect_ref:null,
    response_sha256:null,
    evidence,
  };
}

function providerFor(request, roles, capability) {
  async function state() {
    const [development, production] = await Promise.all([
      capability.readBranch(roles.development),
      capability.readBranch(roles.production),
    ]);
    return { development, production };
  }

  function exactVerification(run) {
    return Number(run?.id) === strictVerificationRunId(request.verification_ref)
      && String(run?.path || '') === '.github/workflows/exact-revision-v8.yml'
      && String(run?.event || '') === 'push'
      && String(run?.head_branch || '') === roles.development
      && String(run?.head_sha || '').toLowerCase() === request.source_revision
      && String(run?.status || '') === 'completed'
      && String(run?.conclusion || '') === 'success';
  }

  return {
    async preflight() {
      const observed = await state();
      if (observed.development.sha !== request.source_revision) {
        return {
          provider:'github',
          observed_revision:observed.development.sha,
          provider_identity:{
            development_head:observed.development.sha,
            production_head:observed.production.sha,
          },
        };
      }
      if (observed.production.sha !== request.production_revision) {
        return {
          provider:'github',
          observed_revision:`production:${observed.production.sha}`,
          provider_identity:{
            development_head:observed.development.sha,
            production_head:observed.production.sha,
          },
        };
      }

      const run = await capability.readVerification(strictVerificationRunId(request.verification_ref));
      if (!exactVerification(run)) {
        return {
          provider:'github',
          observed_revision:`verification:${String(run?.head_sha || '')}`,
          provider_identity:{
            verification_run_id:Number(run?.id || 0),
            verification_head_sha:String(run?.head_sha || '').toLowerCase(),
            verification_status:String(run?.status || ''),
            verification_conclusion:String(run?.conclusion || ''),
          },
        };
      }

      const comparison = await capability.compare(
        request.production_revision,
        request.source_revision,
      );
      if (!['ahead', 'identical'].includes(comparison.status)) {
        return {
          provider:'github',
          observed_revision:`comparison:${comparison.status}`,
          provider_identity:{ comparison_status:comparison.status },
        };
      }

      return {
        provider:'github',
        observed_revision:request.source_revision,
        provider_identity:{
          development_head:observed.development.sha,
          production_head:observed.production.sha,
          verification_run_id:Number(run.id),
          comparison_status:comparison.status,
        },
      };
    },

    async invoke() {
      const observed = await state();
      if (observed.development.sha !== request.source_revision
          || observed.production.sha !== request.production_revision) {
        return rejected({
          reason:'branch_revision_changed_before_mutation',
          expected_development_head:request.source_revision,
          observed_development_head:observed.development.sha,
          expected_production_head:request.production_revision,
          observed_production_head:observed.production.sha,
        });
      }

      if (observed.production.sha === request.source_revision) {
        return accepted(request, roles, {
          outcome:'already_promoted',
          production_head:observed.production.sha,
        });
      }

      const comparison = await capability.compare(
        request.production_revision,
        request.source_revision,
      );
      if (!['ahead', 'identical'].includes(comparison.status)) {
        return rejected({
          reason:'non_fast_forward',
          comparison_status:comparison.status,
          production_head:request.production_revision,
          source_revision:request.source_revision,
        });
      }

      let updateError = null;
      try {
        await capability.updateBranch(roles.production, request.source_revision);
      } catch (error) {
        updateError = error;
      }

      let after;
      try {
        after = await capability.readBranch(roles.production);
      } catch (error) {
        return unknown({
          reason:'promotion_readback_failed',
          update_error:updateError ? String(updateError?.message || updateError) : null,
          readback_error:String(error?.message || error),
        });
      }

      if (after.sha === request.source_revision) {
        return accepted(request, roles, {
          outcome:'promoted',
          production_head:after.sha,
          recovered_from_update_error:Boolean(updateError),
        });
      }

      return unknown({
        reason:'promotion_not_proven',
        intended_head:request.source_revision,
        observed_production_head:after.sha,
        update_error:updateError ? String(updateError?.message || updateError) : null,
      });
    },

    async confirm() {
      const observed = await state();
      if (observed.production.sha === request.source_revision) {
        return {
          status:'confirmed',
          effect_ref:effectRef(request, roles),
          predicate:'github-production-head-equals-source-revision',
          evidence:{
            production_branch:roles.production,
            observed_production_head:observed.production.sha,
            source_revision:request.source_revision,
          },
        };
      }
      if (observed.development.sha === request.source_revision
          && observed.production.sha === request.production_revision) {
        return {
          status:'absent',
          effect_ref:null,
          predicate:'github-production-head-remains-observed-revision',
          evidence:{
            production_branch:roles.production,
            observed_development_head:observed.development.sha,
            observed_production_head:observed.production.sha,
          },
        };
      }
      return {
        status:'unknown',
        effect_ref:null,
        predicate:'github-production-head-readback',
        evidence:{
          production_branch:roles.production,
          observed_development_head:observed.development.sha,
          observed_production_head:observed.production.sha,
          expected_development_head:request.source_revision,
          expected_production_head:request.production_revision,
        },
      };
    },
  };
}

export function productionPromotionCommandResult(result) {
  const sourceRevision = String(result?.source_revision || '').trim().toLowerCase();
  const previousProductionRevision = String(result?.previous_production_revision || '').trim().toLowerCase();
  const productionRevision = String(result?.production_revision || '').trim().toLowerCase();
  const verificationRef = String(result?.verification_ref || '').trim();
  if (!SHA40.test(sourceRevision) || !SHA40.test(previousProductionRevision) || !SHA40.test(productionRevision) || verificationRef.length === 0) {
    const error = new Error('production promotion returned invalid evidence');
    error.code = 'PRODUCTION_PROMOTION_RESULT_INVALID';
    throw error;
  }
  return Object.freeze({
    ok:true,
    source_revision:sourceRevision,
    previous_production_revision:previousProductionRevision,
    production_revision:productionRevision,
    verification_ref:verificationRef,
  });
}

export function productionPromotionFor(options = {}) {
  const db = options.db;
  const withGitHubAppApiClient = options.withGitHubAppApiClient;
  const executionTransactionStore = options.executionTransactionStore;
  if (!executionTransactionStore || typeof executionTransactionStore.prepareExecution !== 'function') {
    throw Object.assign(new Error('the authoritative execution transaction store is required'), {
      code:'EXECUTION_TRANSACTION_STORE_REQUIRED',
      may_have_mutated:false,
    });
  }
  if (typeof withGitHubAppApiClient !== 'function') {
    throw Object.assign(new Error('GitHub App auth provider is required'), {
      code:'RUNTIME_PROVIDER_MISSING',
      details:{ provider:'githubAppAuth' },
      may_have_mutated:false,
    });
  }

  return Object.freeze({
    async promote(intent) {
      const capability = createGithubProductionPromotionCapability(intent.repo, {
        withGitHubAppApiClient,
      });
      const roles = options.branchRoles || await resolveRepositoryBranchRoles(intent.repo, { db });
      if (!roles?.development_branch || !roles?.production_branch) {
        throw Object.assign(new Error('PRODUCTION_PROMOTION_BRANCH_ROLES_UNAVAILABLE'), {
          code:'PRODUCTION_PROMOTION_BRANCH_ROLES_UNAVAILABLE',
          may_have_mutated:false,
        });
      }

      const result = await promoteProduction(intent, {
        async resolveBranchRoles() {
          return {
            development:roles.development_branch,
            production:roles.production_branch,
          };
        },
        async readBranchHead(_repo, branch) {
          return (await capability.readBranch(branch)).sha;
        },
        verifyExactRevision(_repo, revision) {
          return capability.findExactVerification(revision);
        },
        executionTransactionStore,
        executionContext(request) {
          const runId = String(options.runId || `production-promote:${request.repo}:${request.source_revision}:${request.production_revision}`);
          return {
            run_id:runId,
            subject_kind:'provider_operation',
            lease_expires_at:new Date(Date.now() + 60_000).toISOString(),
          };
        },
        providerFor(request, branchRoles) {
          return providerFor(request, branchRoles, capability);
        },
      });
      return productionPromotionCommandResult(result);
    },
  });
}
