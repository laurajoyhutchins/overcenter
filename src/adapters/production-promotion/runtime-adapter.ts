import type { ProductionPromotionPorts } from '../../semantic/production-promotion-operation.js';
import type { ProductionPromotionRuntimeHost } from '../../ports/production-promotion-runtime-host.js';

export type {
  ProductionPromotionRuntimeHost,
  ProductionPromotionVerificationEvidence,
  StrictProductionPromotionRequest,
} from '../../ports/production-promotion-runtime-host.js';

export function createProductionPromotionPorts(
  host: ProductionPromotionRuntimeHost,
): ProductionPromotionPorts {
  return Object.freeze({
    resolveBranchRoles: (repo) => host.resolveBranchRoles(repo),
    readBranchHead: (repo, branch) => host.readBranchHead(repo, branch),
    verifyExactRevision: (repo, revision) => host.verifyExactRevision(repo, revision),
    async promoteVerifiedRevision(request) {
      const evidence = await host.resolveVerificationEvidence(request.verification_ref);
      if (!Number.isInteger(evidence.verification_run_id) || evidence.verification_run_id < 1) {
        throw new Error('PRODUCTION_PROMOTION_VERIFICATION_EVIDENCE_INVALID');
      }

      const idempotencyKey = await host.deriveIdempotencyKey(request);
      if (idempotencyKey.trim().length === 0) {
        throw new Error('PRODUCTION_PROMOTION_IDEMPOTENCY_INVALID');
      }

      return host.invokeStrictPromotion({
        repo: request.repo,
        candidate_sha: request.source_revision,
        observed_development_head: request.source_revision,
        observed_production_head: request.production_revision,
        verification_run_id: evidence.verification_run_id,
        idempotency_key: idempotencyKey,
      });
    },
  });
}