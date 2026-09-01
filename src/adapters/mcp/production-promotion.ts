import type { ProductionPromotionIntent } from '../../semantic/production-promotion-intent.js';
import type { ProductionPromotionResult } from '../../semantic/production-promotion-operation.js';

export type ProductionPromotionMcpRuntime = Readonly<{
  promote(intent: ProductionPromotionIntent): Promise<ProductionPromotionResult>;
}>;

export function createProductionPromotionMcpBinding(
  runtime: ProductionPromotionMcpRuntime,
): (intent: ProductionPromotionIntent) => Promise<ProductionPromotionResult> {
  return (intent) => runtime.promote(intent);
}