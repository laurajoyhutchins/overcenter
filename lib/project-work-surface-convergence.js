import { classifyProjectArtifactBinding, classifyProjectArtifactLineage } from './project-artifact-lineage.js';

const SAFE_TO_RETIRE = new Set(['satisfied', 'superseded', 'orphaned']);
const DEFAULT_DETAIL_LIMIT = 25;

function artifactIdentity(value = {}) {
  const provider = value.binding?.provider || value.lineage?.provider || value.provider || {};
  return Object.freeze({
    repository: String(provider.repository || ''),
    provider_kind: String(provider.kind || ''),
    provider_id: Number(provider.id) || null,
    transition_id: String(value.binding?.transition_id || value.lineage?.transition_id || value.transition_id || ''),
  });
}

function classifyOne(value = {}, context = {}) {
  const identity = artifactIdentity(value);
  let result;
  if (value.binding) {
    result = classifyProjectArtifactBinding(value.binding, { provider: value.provider });
  } else if (value.lineage) {
    result = classifyProjectArtifactLineage(value.lineage, {
      newer_lineage: value.newer_lineage || null,
      current_project_transition_ids: context.current_project_transition_ids,
      live_execution_provider_ids: context.live_execution_provider_ids,
      overcenter_owned_provider_ids: context.overcenter_owned_provider_ids,
    });
  } else {
    result = Object.freeze({ classification:'ambiguous', evidence:Object.freeze({ reason:'durable-lineage-or-binding-absent' }) });
  }

  const classification = String(result.classification || 'ambiguous');
  const disposition = classification === 'active'
    ? 'active'
    : SAFE_TO_RETIRE.has(classification)
      ? 'safe_to_retire'
      : 'ambiguous';
  return Object.freeze({ ...identity, disposition, classification, evidence:result.evidence || Object.freeze({}) });
}

export function deriveProjectWorkSurfaceConvergence(input = {}) {
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  const detailLimit = Number.isInteger(input.detail_limit) && input.detail_limit > 0
    ? Math.min(input.detail_limit, 100)
    : DEFAULT_DETAIL_LIMIT;
  const classified = artifacts.map((artifact) => classifyOne(artifact, input));
  const byDisposition = (disposition) => classified.filter((item) => item.disposition === disposition);
  const active = byDisposition('active');
  const safeToRetire = byDisposition('safe_to_retire');
  const ambiguous = byDisposition('ambiguous');
  return Object.freeze({
    schema:'project-work-surface-convergence-v1',
    counts:Object.freeze({ active:active.length, safe_to_retire:safeToRetire.length, ambiguous:ambiguous.length, total:classified.length }),
    active:Object.freeze(active.slice(0, detailLimit)),
    safe_to_retire:Object.freeze(safeToRetire.slice(0, detailLimit)),
    ambiguous:Object.freeze(ambiguous.slice(0, detailLimit)),
    truncated:Object.freeze({ active:active.length > detailLimit, safe_to_retire:safeToRetire.length > detailLimit, ambiguous:ambiguous.length > detailLimit }),
  });
}