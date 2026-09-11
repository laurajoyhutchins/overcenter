import { canonicalJson, sha256Text } from './canonical-json.js';
import { executeExecutionTransaction } from './execution-transaction-runtime.js';

export class ProductionPromotionFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProductionPromotionFailure';
    this.code = code;
    this.may_have_mutated = false;
  }
}

function promotionPayload(request, roles) {
  return Object.freeze({
    repo:request.repo,
    development_branch:roles.development,
    production_branch:roles.production,
    source_revision:request.source_revision,
    production_revision:request.production_revision,
    verification_ref:request.verification_ref,
  });
}

async function promotionIdempotencyKey(request) {
  const digest = await sha256Text(canonicalJson(request));
  return `production-promote:${digest}`;
}

export async function promoteProduction(intent, ports) {
  const roles = await ports.resolveBranchRoles(intent.repo);
  const sourceRevision = await ports.readBranchHead(intent.repo, roles.development);
  const productionRevision = await ports.readBranchHead(intent.repo, roles.production);
  const verification = await ports.verifyExactRevision(intent.repo, sourceRevision);

  if (
    !verification.verified
    || verification.revision !== sourceRevision
    || verification.verification_ref.trim().length === 0
  ) {
    throw new ProductionPromotionFailure('PRODUCTION_PROMOTION_SOURCE_NOT_VERIFIED');
  }

  const request = Object.freeze({
    repo:intent.repo,
    source_revision:sourceRevision,
    production_revision:productionRevision,
    verification_ref:verification.verification_ref,
  });
  const projectRef = `github:${intent.repo}`;
  const transactionIntent = {
    project_ref:projectRef,
    subject_key:`${projectRef}:production`,
    authority:{
      project_ref:projectRef,
      repository:intent.repo,
      revision:sourceRevision,
      epoch:0,
      graph_fingerprint:`github.branch-roles:${roles.development}:${roles.production}`,
      transition_fingerprint:`production-promotion:${sourceRevision}:${productionRevision}`,
    },
    operation:{
      kind:'github.production.promote',
      idempotency_scope:`repository:${intent.repo}`,
      idempotency_key:await promotionIdempotencyKey(request),
      payload:promotionPayload(request, roles),
    },
  };

  const transaction = await executeExecutionTransaction({
    intent:transactionIntent,
    context:ports.executionContext(request),
    provider:ports.providerFor(request, roles),
    store:ports.executionTransactionStore,
  });
  if (transaction.receipt.disposition !== 'completed') {
    throw new ProductionPromotionFailure('PRODUCTION_PROMOTION_NOT_COMPLETED');
  }

  return Object.freeze({
    source_revision:sourceRevision,
    previous_production_revision:productionRevision,
    production_revision:sourceRevision,
    verification_ref:verification.verification_ref,
  });
}
