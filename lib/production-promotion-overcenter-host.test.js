import { productionPromotionCommandResult } from './production-promotion-overcenter-host.js';
import { promoteProduction } from './production-promotion-operation.js';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function testProductionPromotionHostReturnsCommandEvidenceEnvelope() {
  const sourceRevision = 'a'.repeat(40);
  const previousProductionRevision = 'b'.repeat(40);
  const result = productionPromotionCommandResult({
    source_revision: sourceRevision,
    previous_production_revision: previousProductionRevision,
    production_revision: sourceRevision,
    verification_ref: 'github-actions-run:123',
  });
  check(result?.ok === true, 'production promotion runtime host must mark a successful semantic result ok:true');
  check(result?.source_revision === sourceRevision, 'production promotion runtime host must preserve the exact verified source revision');
  check(result?.previous_production_revision === previousProductionRevision, 'production promotion runtime host must preserve the observed prior production revision');
  check(result?.production_revision === sourceRevision, 'production promotion runtime host must preserve the exact promoted revision');
  check(result?.verification_ref === 'github-actions-run:123', 'production promotion runtime host must preserve exact verification evidence');
}

async function testPromotionOperationTypesUnverifiedSourceAsSafeFailure() {
  let promotionCalled = false;
  let observedFailure = null;
  try {
    await promoteProduction({ repo: 'laurajoyhutchins/overcenter' }, {
      resolveBranchRoles: async () => ({ development: 'dev', production: 'main' }),
      readBranchHead: async (_repo, branch) => branch === 'dev' ? 'a'.repeat(40) : 'b'.repeat(40),
      verifyExactRevision: async (_repo, revision) => ({ revision, verified: false, verification_ref: '' }),
      promoteVerifiedRevision: async () => {
        promotionCalled = true;
        return { production_revision: 'a'.repeat(40) };
      },
    });
  } catch (error) {
    observedFailure = error;
  }

  check(observedFailure?.code === 'PRODUCTION_PROMOTION_SOURCE_NOT_VERIFIED', 'unverified source should preserve its semantic failure code');
  check(observedFailure?.may_have_mutated === false, 'unverified source should prove no mutation occurred');
  check(promotionCalled === false, 'unverified source must not reach the mutation port');
}

export async function runProductionPromotionOvercenterHostTests() {
  await testProductionPromotionHostReturnsCommandEvidenceEnvelope();
  await testPromotionOperationTypesUnverifiedSourceAsSafeFailure();
  return { ok:true, tests:2 };
}