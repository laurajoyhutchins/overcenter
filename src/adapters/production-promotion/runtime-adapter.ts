import type { ProductionPromotionPorts } from '../../semantic/production-promotion-operation.js';
import type { ProductionPromotionRuntimeHost } from '../../ports/production-promotion-runtime-host.js';

export type { ProductionPromotionRuntimeHost } from '../../ports/production-promotion-runtime-host.js';

export function createProductionPromotionPorts(
  host: ProductionPromotionRuntimeHost,
): ProductionPromotionPorts {
  return Object.freeze({
    resolveBranchRoles: (repo) => host.resolveBranchRoles(repo),
    readBranchHead: (repo, branch) => host.readBranchHead(repo, branch),
    verifyExactRevision: (repo, revision) => host.verifyExactRevision(repo, revision),
    executionTransactionStore: host.executionTransactionStore,
    executionContext: (input) => host.executionContext(input),
    providerFor: (input, roles) => host.providerFor(input, roles),
  });
}
