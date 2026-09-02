import { readFile } from 'node:fs/promises';
import {
  CONTRACT_CLASSIFICATION_SCHEMA,
  assertCandidate,
  assertClassificationDocument,
} from './model.mjs';

const AUTOMATIC_PROJECTION_RELATIONSHIP_KINDS = new Set([
  'generated-projection-of',
  'structural-projection-of',
]);

function fail(code, message, details = null) {
  const error = new Error(message);
  Object.assign(error, { code, details });
  throw error;
}

export async function loadClassifications(path) {
  try {
    const source = await readFile(path, 'utf8');
    return assertClassificationDocument(JSON.parse(source));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { schema:CONTRACT_CLASSIFICATION_SCHEMA, candidates:{} };
    }
    throw error;
  }
}

function projectionRecord(candidate, automatic = false) {
  return Object.freeze({
    source_identity:candidate.source_identity,
    source_kind:candidate.source_kind,
    structural_fingerprint:candidate.structural_fingerprint,
    ...(automatic ? { automatic:true } : {}),
  });
}

export function resolveLogicalContracts(candidates, classificationDocument, options = {}) {
  const document = assertClassificationDocument(classificationDocument);
  const allowedSemverKinds = options.allowedSemverKinds;
  const bySource = new Map();

  for (const candidate of candidates) {
    assertCandidate(candidate);
    if (bySource.has(candidate.source_identity)) {
      fail('CONTRACT_DUPLICATE_SOURCE_IDENTITY', 'duplicate contract source identity', { source_identity:candidate.source_identity });
    }
    bySource.set(candidate.source_identity, candidate);
  }

  for (const sourceIdentity of Object.keys(document.candidates)) {
    if (!bySource.has(sourceIdentity)) {
      fail('CONTRACT_CLASSIFICATION_SOURCE_MISSING', 'classification references a missing candidate', { source_identity:sourceIdentity });
    }
  }

  const logical = new Map();
  const sourceToLogical = new Map();

  for (const [sourceIdentity, classification] of Object.entries(document.candidates).sort(([a], [b]) => a.localeCompare(b))) {
    if (classification.significance === 'projection') continue;
    if (!classification.logical_contract) {
      fail('CONTRACT_CLASSIFICATION_INVALID', 'non-projection classification requires logical_contract', { source_identity:sourceIdentity });
    }
    if (classification.projection_of) {
      fail('CONTRACT_CLASSIFICATION_INVALID', 'non-projection classification cannot set projection_of', { source_identity:sourceIdentity });
    }
    if (classification.semver_kind && allowedSemverKinds instanceof Set && !allowedSemverKinds.has(classification.semver_kind)) {
      fail('CONTRACT_SEMVER_KIND_UNKNOWN', 'classification uses an unknown SemVer compatibility kind', {
        source_identity:sourceIdentity,
        semver_kind:classification.semver_kind,
      });
    }
    if (logical.has(classification.logical_contract)) {
      fail('CONTRACT_MULTIPLE_AUTHORITIES', 'logical contract has multiple authorities', {
        logical_contract:classification.logical_contract,
        authorities:[logical.get(classification.logical_contract).authority.source_identity, sourceIdentity].sort(),
      });
    }
    const candidate = bySource.get(sourceIdentity);
    const entry = {
      id:classification.logical_contract,
      authority:Object.freeze({
        source_identity:sourceIdentity,
        source_kind:candidate.source_kind,
        significance:classification.significance,
        structural_fingerprint:candidate.structural_fingerprint,
        ...(classification.semver_kind ? { semver_kind:classification.semver_kind } : {}),
      }),
      projections:[],
      relationships:[...(classification.relationships || [])],
      ...(classification.lifecycle ? { lifecycle:classification.lifecycle } : {}),
    };
    logical.set(classification.logical_contract, entry);
    sourceToLogical.set(sourceIdentity, classification.logical_contract);
  }

  for (const [sourceIdentity, classification] of Object.entries(document.candidates).sort(([a], [b]) => a.localeCompare(b))) {
    if (classification.significance !== 'projection') continue;
    if (classification.semver_kind) {
      fail('CONTRACT_PROJECTION_SEMVER_OVERRIDE', 'projections inherit SemVer significance from their authority', { source_identity:sourceIdentity });
    }
    if (!classification.projection_of || classification.logical_contract) {
      fail('CONTRACT_CLASSIFICATION_INVALID', 'projection classification requires projection_of and no logical_contract', { source_identity:sourceIdentity });
    }
    const target = logical.get(classification.projection_of);
    if (!target) {
      fail('CONTRACT_PROJECTION_TARGET_MISSING', 'projection references a missing logical authority', {
        source_identity:sourceIdentity,
        projection_of:classification.projection_of,
      });
    }
    target.projections.push(projectionRecord(bySource.get(sourceIdentity)));
    sourceToLogical.set(sourceIdentity, classification.projection_of);
  }

  const automaticProjectionSources = new Set();
  for (const candidate of [...bySource.values()].sort((a, b) => a.source_identity.localeCompare(b.source_identity))) {
    const relationships = candidate.observed_relationships.filter((item) => AUTOMATIC_PROJECTION_RELATIONSHIP_KINDS.has(item?.kind));
    if (!relationships.length) continue;
    if (relationships.length !== 1 || typeof relationships[0].target !== 'string' || !bySource.has(relationships[0].target)) {
      fail('CONTRACT_GENERATED_PROJECTION_AMBIGUOUS', 'automatic projection relationship must resolve to exactly one observed source', {
        source_identity:candidate.source_identity,
        targets:relationships.map((item) => item?.target ?? null),
      });
    }
    automaticProjectionSources.add(candidate.source_identity);
    const targetSource = relationships[0].target;
    const logicalId = sourceToLogical.get(targetSource);
    if (logicalId) {
      const target = logical.get(logicalId);
      if (!target.projections.some((item) => item.source_identity === candidate.source_identity)) {
        target.projections.push(projectionRecord(candidate, true));
      }
      sourceToLogical.set(candidate.source_identity, logicalId);
    }
  }

  for (const entry of logical.values()) {
    const deduplicated = new Map();
    for (const relationship of entry.relationships) {
      if (!logical.has(relationship.target)) {
        fail('CONTRACT_RELATIONSHIP_TARGET_MISSING', 'logical contract relationship references a missing target', {
          logical_contract:entry.id,
          kind:relationship.kind,
          target:relationship.target,
        });
      }
      if (relationship.target === entry.id) {
        fail('CONTRACT_RELATIONSHIP_SELF_REFERENCE', 'logical contract relationship cannot target itself', {
          logical_contract:entry.id,
          kind:relationship.kind,
        });
      }
      deduplicated.set(`${relationship.kind}::${relationship.target}`, Object.freeze({ kind:relationship.kind, target:relationship.target }));
    }
    entry.relationships = [...deduplicated.values()].sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.target.localeCompare(right.target));
  }

  const classifiedSources = new Set(Object.keys(document.candidates));
  const unclassified = [...bySource.keys()]
    .filter((sourceIdentity) => !classifiedSources.has(sourceIdentity) && !automaticProjectionSources.has(sourceIdentity))
    .sort();

  const logicalContracts = [...logical.values()]
    .map((entry) => Object.freeze({
      id:entry.id,
      authority:entry.authority,
      ...(entry.lifecycle ? { lifecycle:entry.lifecycle } : {}),
      relationships:Object.freeze([...entry.relationships]),
      projections:Object.freeze([...entry.projections].sort((a, b) => a.source_identity.localeCompare(b.source_identity))),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return Object.freeze({
    candidates:Object.freeze([...bySource.values()].sort((a, b) => a.source_identity.localeCompare(b.source_identity))),
    logical_contracts:Object.freeze(logicalContracts),
    unclassified_source_identities:Object.freeze(unclassified),
  });
}

export function unclassifiedSourceIdentities(resolution) {
  return [...(resolution?.unclassified_source_identities || [])].sort();
}