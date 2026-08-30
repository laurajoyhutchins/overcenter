import { productionPromotionCommandResult } from './production-promotion-overcenter-host.js';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function testProductionPromotionHostReturnsCommandSuccessEnvelope() {
  const revision = 'a'.repeat(40);
  const result = productionPromotionCommandResult({ production_revision: revision });
  check(result?.ok === true, 'production promotion runtime host must mark a successful semantic result ok:true');
  check(result?.production_revision === revision, 'production promotion runtime host must preserve the exact promoted revision');
}

export async function runProductionPromotionOvercenterHostTests() {
  await testProductionPromotionHostReturnsCommandSuccessEnvelope();
  return { ok:true, tests:1 };
}