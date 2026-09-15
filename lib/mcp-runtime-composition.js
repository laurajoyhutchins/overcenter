import { composeHatchableRuntimeProviders } from './hatchable-runtime-providers.js';

export function composeMcpRuntimeProviders(ctx = {}) {
  return composeHatchableRuntimeProviders({
    ...(ctx?.db ? { db:ctx.db } : {}),
  });
}
