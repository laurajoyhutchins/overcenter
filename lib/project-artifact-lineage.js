const SHA40 = /^[0-9a-f]{40}$/;
const PROJECT_REF = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/;
const PROVIDER_KINDS = new Set(['pull_request', 'issue']);

function fail(message, details = {}) {
  const error = new Error(message);
  error.code = 'PROJECT_ARTIFACT_LINEAGE_AMBIGUOUS';
  error.details = Object.freeze(details);
  throw error;
}

function requiredText(value, field, max = 512) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) fail(`${field} is required for artifact lineage`, { field });
  return text;
}

function exactRevision(value, field) {
  const revision = requiredText(value, field, 40).toLowerCase();
  if (!SHA40.test(revision)) fail(`${field} must be an exact Git revision`, { field, revision });
  return revision;
}

function providerIdentity(input, repository) {
  const kind = requiredText(input?.kind, 'provider.kind', 64);
  const id = Number(input?.id);
  if (!PROVIDER_KINDS.has(kind) || !Number.isInteger(id) || id < 1) {
    fail('provider object identity is invalid', { kind, id: input?.id ?? null });
  }
  return Object.freeze({ repository, kind, id });
}

function candidateIdentity(candidate, provider, authorityRevision) {
  if (provider.kind !== 'pull_request') return null;
  const head = exactRevision(candidate?.head, 'candidate.head');
  const base = exactRevision(candidate?.base, 'candidate.base');
  if (provider.head != null && exactRevision(provider.head, 'provider.head') !== head) {
    fail('provider candidate head does not match exact candidate head', { provider_id: provider.id });
  }
  if (provider.base != null && exactRevision(provider.base, 'provider.base') !== base) {
    fail('provider candidate base does not match exact candidate base', { provider_id: provider.id });
  }
  return Object.freeze({ head, base, authority_revision: authorityRevision });
}

function integrationIdentity(value, candidate) {
  if (value == null) return null;
  if (!candidate) fail('integration evidence requires a pull-request candidate');
  const outcome = requiredText(value.outcome, 'integration.outcome', 64).toLowerCase();
  const expectedHead = exactRevision(value.expected_head, 'integration.expected_head');
  if (expectedHead !== candidate.head) fail('integration evidence is bound to a different candidate head');
  const mergeCommit = value.merge_commit_sha == null ? null : exactRevision(value.merge_commit_sha, 'integration.merge_commit_sha');
  return Object.freeze({ outcome, expected_head: expectedHead, merge_commit_sha: mergeCommit });
}

function settlementIdentity(value) {
  if (value == null) return null;
  const disposition = requiredText(value.disposition, 'settlement.disposition', 32).toLowerCase();
  const evidence = Array.isArray(value.evidence_refs) ? value.evidence_refs.map((item, index) => Object.freeze({
    kind: requiredText(item?.kind, `settlement.evidence_refs[${index}].kind`, 128),
    ref: requiredText(item?.ref, `settlement.evidence_refs[${index}].ref`, 1024),
  })) : [];
  return Object.freeze({ disposition, evidence_refs: Object.freeze(evidence) });
}

export function reconstructProjectArtifactLineage(facts = {}) {
  const match = requiredText(facts.project_ref, 'project_ref', 300).match(PROJECT_REF);
  if (!match) fail('project_ref must identify one GitHub repository');
  const repository = requiredText(facts.repository, 'repository', 256);
  if (repository !== match[1]) fail('repository identity does not match project_ref', { repository, project_ref: facts.project_ref });
  const transitionId = requiredText(facts.transition_id, 'transition identity', 256);
  const semanticOperation = requiredText(facts.semantic_operation, 'semantic_operation', 256);
  const idempotencyIdentity = requiredText(facts.idempotency_identity, 'idempotency_identity', 512);
  const authorityRevision = exactRevision(facts.authority_revision, 'authority_revision');
  const provider = providerIdentity(facts.provider, repository);
  const candidate = candidateIdentity(facts.candidate, facts.provider || {}, authorityRevision);
  const integration = integrationIdentity(facts.integration, candidate);
  const settlement = settlementIdentity(facts.settlement);

  return Object.freeze({
    schema: 'project-artifact-lineage-v1',
    provenance: 'durable-facts',
    project_ref: facts.project_ref,
    transition_id: transitionId,
    semantic_operation: semanticOperation,
    idempotency_identity: idempotencyIdentity,
    authority_revision: authorityRevision,
    provider,
    candidate,
    integration,
    settlement,
    provider_state: requiredText(facts.provider?.state, 'provider.state', 64).toLowerCase(),
  });
}

function sameSemanticObligation(left, right) {
  return left?.project_ref === right?.project_ref
    && left?.transition_id === right?.transition_id
    && left?.semantic_operation === right?.semantic_operation;
}

function exactProviderIdSet(values) {
  return new Set((Array.isArray(values) ? values : []).filter((value) => Number.isInteger(Number(value))).map(Number));
}

export function classifyProjectArtifactLineage(lineage, context = {}) {
  if (!lineage || lineage.schema !== 'project-artifact-lineage-v1') fail('reconstructed artifact lineage is required');

  if (lineage.integration?.outcome === 'merged'
      && lineage.integration.merge_commit_sha
      && lineage.settlement?.disposition === 'completed') {
    return Object.freeze({ classification: 'satisfied', evidence: Object.freeze({
      merge_commit_sha: lineage.integration.merge_commit_sha,
      settlement_disposition: lineage.settlement.disposition,
    }) });
  }

  const newer = context.newer_lineage || null;
  if (newer && sameSemanticObligation(lineage, newer)
      && newer.provider.repository === lineage.provider.repository
      && newer.provider.kind === lineage.provider.kind
      && newer.provider.id !== lineage.provider.id
      && newer.candidate?.head && lineage.candidate?.head
      && newer.candidate.head !== lineage.candidate.head) {
    return Object.freeze({ classification: 'superseded', evidence: Object.freeze({
      newer_provider_id: newer.provider.id,
      newer_candidate_head: newer.candidate.head,
    }) });
  }

  const currentTransitionIds = Array.isArray(context.current_project_transition_ids)
    ? new Set(context.current_project_transition_ids.map(String))
    : null;
  const liveProviderIds = exactProviderIdSet(context.live_execution_provider_ids);
  const ownedProviderIds = exactProviderIdSet(context.overcenter_owned_provider_ids);
  if (currentTransitionIds && !currentTransitionIds.has(lineage.transition_id)) {
    if (liveProviderIds.has(lineage.provider.id)) {
      return Object.freeze({ classification: 'active', evidence: Object.freeze({ live_execution: true }) });
    }
    if (ownedProviderIds.has(lineage.provider.id)) {
      return Object.freeze({ classification: 'orphaned', evidence: Object.freeze({
        exact_overcenter_ownership: true,
        current_transition_absent: true,
        live_continuation_absent: true,
      }) });
    }
    return Object.freeze({ classification: 'ambiguous', evidence: Object.freeze({
      reason: 'overcenter-ownership-unproven',
    }) });
  }

  return Object.freeze({ classification: 'active', evidence: Object.freeze({ current_transition: true }) });
}

export function bindProjectArtifact(input = {}) {
  const match = requiredText(input.project_ref, 'project_ref', 300).match(PROJECT_REF);
  if (!match) fail('project_ref must identify one GitHub repository');
  const repository = requiredText(input.repository, 'repository', 256);
  if (repository !== match[1]) fail('repository identity does not match project_ref', { repository, project_ref: input.project_ref });
  const transitionId = requiredText(input.transition_id, 'transition identity', 256);
  const authorityRevision = exactRevision(input.authority_revision, 'authority_revision');
  const provider = providerIdentity(input.provider, repository);
  const relationship = requiredText(input.relationship, 'relationship', 64).toLowerCase();
  if (relationship !== 'satisfies') fail('artifact binding relationship is unsupported', { relationship });
  const condition = requiredText(input.satisfaction?.condition, 'satisfaction.condition', 64).toLowerCase();
  const supported = provider.kind === 'issue'
    ? condition === 'closed'
    : condition === 'merged';
  if (!supported) fail('artifact satisfaction condition is unsupported for provider kind', { provider_kind: provider.kind, condition });

  return Object.freeze({
    schema: 'project-artifact-binding-v1',
    provenance: 'explicit-binding',
    project_ref: input.project_ref,
    transition_id: transitionId,
    authority_revision: authorityRevision,
    provider,
    relationship,
    satisfaction: Object.freeze({ condition }),
  });
}

export function classifyProjectArtifactBinding(binding, context = {}) {
  if (!binding) {
    return Object.freeze({ classification: 'ambiguous', evidence: Object.freeze({ reason: 'durable-binding-absent' }) });
  }
  if (binding.schema !== 'project-artifact-binding-v1') fail('explicit project artifact binding is required');

  const observed = context.provider;
  if (!observed || observed.repository !== binding.provider.repository
      || observed.kind !== binding.provider.kind
      || Number(observed.id) !== binding.provider.id) {
    return Object.freeze({ classification: 'ambiguous', evidence: Object.freeze({ reason: 'provider-identity-mismatch' }) });
  }

  const state = requiredText(observed.state, 'provider.state', 64).toLowerCase();
  const satisfied = (binding.provider.kind === 'issue' && binding.satisfaction.condition === 'closed' && state === 'closed')
    || (binding.provider.kind === 'pull_request' && binding.satisfaction.condition === 'merged' && state === 'merged');
  if (satisfied) {
    return Object.freeze({ classification: 'satisfied', evidence: Object.freeze({
      repository: binding.provider.repository,
      provider_kind: binding.provider.kind,
      provider_id: binding.provider.id,
      provider_state: state,
      relationship: binding.relationship,
      condition: binding.satisfaction.condition,
    }) });
  }

  return Object.freeze({ classification: 'active', evidence: Object.freeze({
    repository: binding.provider.repository,
    provider_kind: binding.provider.kind,
    provider_id: binding.provider.id,
    provider_state: state,
    condition: binding.satisfaction.condition,
  }) });
}