import test from 'node:test';
import assert from 'node:assert/strict';
import { productionPromotionCommandResult } from './production-promotion-overcenter-host.js';
import { promoteProduction } from './production-promotion-operation.js';

test('production promotion host returns command evidence envelope', () => {
  const sourceRevision = 'a'.repeat(40);
  const previousProductionRevision = 'b'.repeat(40);
  const result = productionPromotionCommandResult({
    source_revision: sourceRevision,
    previous_production_revision: previousProductionRevision,
    production_revision: sourceRevision,
    verification_ref: 'github-actions-run:123',
  });
  assert.equal(result?.ok, true);
  assert.equal(result?.source_revision, sourceRevision);
  assert.equal(result?.previous_production_revision, previousProductionRevision);
  assert.equal(result?.production_revision, sourceRevision);
  assert.equal(result?.verification_ref, 'github-actions-run:123');
});

test('promotion operation types unverified source as safe failure', async () => {
  let promotionCalled = false;
  await assert.rejects(
    promoteProduction({ repo: 'laurajoyhutchins/overcenter' }, {
      resolveBranchRoles: async () => ({ development: 'dev', production: 'main' }),
      readBranchHead: async (_repo, branch) => branch === 'dev' ? 'a'.repeat(40) : 'b'.repeat(40),
      verifyExactRevision: async (_repo, revision) => ({ revision, verified: false, verification_ref: '' }),
      promoteVerifiedRevision: async () => {
        promotionCalled = true;
        return { production_revision: 'a'.repeat(40) };
      },
    }),
    (error) => error?.code === 'PRODUCTION_PROMOTION_SOURCE_NOT_VERIFIED' && error?.may_have_mutated === false,
  );
  assert.equal(promotionCalled, false);
});
