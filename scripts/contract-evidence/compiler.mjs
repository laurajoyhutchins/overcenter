import { buildCatalog } from './catalog.mjs';
import { loadClassifications, resolveLogicalContracts } from './resolver.mjs';

function fail(code, message, details = {}) {
  const error = new Error(message);
  Object.assign(error, { code, ...details });
  throw error;
}

export async function compileCatalog(options = {}) {
  const repoRoot = options.repoRoot || '.';
  const discoverers = Array.isArray(options.discoverers) ? options.discoverers : [];
  const candidates = [];

  for (const discoverer of discoverers) {
    const name = typeof discoverer?.name === 'string' && discoverer.name ? discoverer.name : 'unnamed';
    if (!discoverer || typeof discoverer.discover !== 'function') {
      fail('CONTRACT_DISCOVERY_FAILED', 'configured discoverer is invalid', { discoverer:name });
    }
    let result;
    try {
      result = await discoverer.discover({ repoRoot });
    } catch (cause) {
      const error = new Error(`contract discoverer ${name} failed`, { cause });
      Object.assign(error, { code:'CONTRACT_DISCOVERY_FAILED', discoverer:name, cause_code:cause?.code || null });
      throw error;
    }
    if (!result || result.complete !== true || !Array.isArray(result.candidates) || !Array.isArray(result.diagnostics || [])) {
      fail('CONTRACT_DISCOVERY_INCOMPLETE', `contract discoverer ${name} did not prove complete traversal`, {
        discoverer:name,
        diagnostics:Array.isArray(result?.diagnostics) ? result.diagnostics : [],
      });
    }
    candidates.push(...result.candidates);
  }

  const classificationDocument = options.classificationDocument
    || await loadClassifications(options.classificationPath || `${repoRoot}/.contract-evidence/classifications.json`);
  const resolution = resolveLogicalContracts(candidates, classificationDocument, {
    allowedSemverKinds:options.allowedSemverKinds,
  });
  return buildCatalog(resolution);
}
