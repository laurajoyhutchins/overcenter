export type ProductionPromotionIntent = Readonly<{
  repo: string;
}>;

export function productionPromotionIntent(input: ProductionPromotionIntent): ProductionPromotionIntent {
  return Object.freeze({ repo: input.repo });
}