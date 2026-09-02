import { CONTRACT_CATALOG_SCHEMA } from './model.mjs';

export function buildCatalog(resolution) {
  const candidates = [...(resolution?.candidates || [])].sort((a, b) => a.source_identity.localeCompare(b.source_identity));
  const logicalContracts = [...(resolution?.logical_contracts || [])].sort((a, b) => a.id.localeCompare(b.id));
  const unclassified = [...(resolution?.unclassified_source_identities || [])].sort();
  return Object.freeze({
    schema:CONTRACT_CATALOG_SCHEMA,
    repository:Object.freeze({ root_marker:'.' }),
    generated_by:Object.freeze({ protocol:CONTRACT_CATALOG_SCHEMA }),
    candidates:Object.freeze(candidates),
    logical_contracts:Object.freeze(logicalContracts),
    unclassified_source_identities:Object.freeze(unclassified),
    summary:Object.freeze({
      discovered:candidates.length,
      classified:candidates.length - unclassified.length,
      unclassified:unclassified.length,
      logical_contracts:logicalContracts.length,
    }),
  });
}
