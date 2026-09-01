import type { ProductionPromotionIntent } from '../semantic/production-promotion-intent.js';
import { promoteProduction, type ProductionPromotionResult } from '../semantic/production-promotion-operation.js';
import { createProductionPromotionPorts } from '../adapters/production-promotion/runtime-adapter.js';
import type { ProductionPromotionRuntimeHost } from '../ports/production-promotion-runtime-host.js';

export type ProductionPromotionRuntime = Readonly<{
  promote(intent: ProductionPromotionIntent): Promise<ProductionPromotionResult>;
}>;

export function createProductionPromotionRuntime(
  host: ProductionPromotionRuntimeHost,
): ProductionPromotionRuntime {
  const ports = createProductionPromotionPorts(host);
  return Object.freeze({
    promote: (intent) => promoteProduction(intent, ports),
  });
}