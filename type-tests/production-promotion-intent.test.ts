import {
  productionPromotionIntent,
  type ProductionPromotionIntent,
} from '../src/semantic/production-promotion-intent';

const intent: ProductionPromotionIntent = productionPromotionIntent({
  repo: 'laurajoyhutchins/overcenter',
});

const repo: string = intent.repo;
void repo;

// @ts-expect-error primary promotion intent must not accept provider/runtime coordinates
productionPromotionIntent({ repo: 'laurajoyhutchins/overcenter', verification_run_id: 'host-specific' });

// @ts-expect-error repository identity remains required
productionPromotionIntent({});