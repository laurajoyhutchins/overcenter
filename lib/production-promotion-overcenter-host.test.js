import { productionPromotionCommandResult } from './production-promotion-overcenter-host.js';

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

export async function runProductionPromotionOvercenterHostTests() {
  await testProductionPromotionHostReturnsCommandEvidenceEnvelope();
  return { ok:true, tests:1 };
}