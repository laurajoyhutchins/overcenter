import type { ProductionPromotionIntent } from '../semantic/production-promotion-intent';
import { promoteProduction, type ProductionPromotionResult } from '../semantic/production-promotion-operation';
import { createProductionPromotionPorts, type ProductionPromotionRuntimeHost } from './production-promotion-runtime-adapter';

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