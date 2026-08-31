import { productionPromotionCommandResult } from './production-promotion-overcenter-host.js';
import { promoteProduction } from './production-promotion-operation.js';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalResult() {
  return {
    source_revision: '1'.repeat(40),
    previous_production_revision: '0'.repeat(40),
    production_revision: '1'.repeat(40),
    verification_ref: 'verification:opaque:123',
  };
}

async function testPromotionHostReturnsCommandEnvelope() {
  const result = await productionPromotionCommandResult({ repo: 'laurajoyhutchins/overcenter' }, {
    promoteProduction: async (intent) => {
      check(intent.repo === 'laurajoyhutchins/overcenter', 'host should pass semantic intent to the operation');
      return canonicalResult();
    },
  });

  check(result.ok === true, 'host should return a canonical command success envelope');
  check(result.source_revision === '1'.repeat(40), 'host should preserve semantic source revision');
  check(result.previous_production_revision === '0'.repeat(40), 'host should preserve previous production revision');
  check(result.production_revision === '1'.repeat(40), 'host should preserve production revision');
  check(result.verification_ref === 'verification:opaque:123', 'host should preserve opaque verification evidence');
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

void testPromotionHostReturnsCommandEnvelope()
  .then(() => testPromotionOperationTypesUnverifiedSourceAsSafeFailure())
  .then(() => console.log('production promotion Overcenter host tests passed'));