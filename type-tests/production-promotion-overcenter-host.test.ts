import { createProductionPromotionRuntime } from '../src/runtime/production-promotion-overcenter-host';
import type { ProductionPromotionRuntimeHost } from '../src/ports/production-promotion-runtime-host';
import type { ProductionPromotionIntent } from '../src/semantic/production-promotion-intent';

const host = {} as ProductionPromotionRuntimeHost;
const runtime = createProductionPromotionRuntime(host);
const intent: ProductionPromotionIntent = { repo: 'owner/repo' };

const result: Promise<{ production_revision: string }> = runtime.promote(intent);
void result;