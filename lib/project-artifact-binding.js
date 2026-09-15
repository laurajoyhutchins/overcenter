import { bindProjectArtifact, classifyProjectArtifactBinding } from './project-artifact-lineage.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function requiredRuntime(runtime, name) {
  if (typeof runtime?.[name] !== 'function') {
    fail('PROJECT_ARTIFACT_BINDING_RUNTIME_INVALID', 'binding runtime dependency is unavailable', { dependency:name });
  }
  return runtime[name];
}

function exactRevision(value) {
  const revision = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(revision)) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'expected_revision must be an exact Git revision');
  return revision;
}

export function createProjectArtifactBindingService(runtime = {}) {
  const readProjectGraph = requiredRuntime(runtime, 'readProjectGraph');
  const readProviderArtifact = requiredRuntime(runtime, 'readProviderArtifact');
  const bindingRefFor = requiredRuntime(runtime, 'bindingRefFor');
  const appendBindingObservation = requiredRuntime(runtime, 'appendBindingObservation');

  return Object.freeze({
    async bind(input = {}) {
      const projectRef = typeof input.project_ref === 'string' ? input.project_ref.trim() : '';
      const expectedRevision = exactRevision(input.expected_revision);
      const graph = await readProjectGraph(Object.freeze({ project_ref:projectRef }));
      const authority = graph?.authority?.definition;
      if (!authority || String(authority.kind || '').toLowerCase() !== 'github' || String(authority.revision || '').toLowerCase() !== expectedRevision) {
        fail('PROJECT_ARTIFACT_BINDING_AUTHORITY_STALE', 'project artifact binding authority changed before mutation', { expected_revision:expectedRevision, actual_revision:authority?.revision || null });
      }
      if (!Array.isArray(graph.nodes) || !graph.nodes.some((node) => String(node?.id || '') === String(input.transition_id || ''))) {
        fail('PROJECT_ARTIFACT_BINDING_SUBJECT_NOT_FOUND', 'transition is absent from the exact authoritative project graph', { transition_id:input.transition_id || null });
      }

      const kind = String(input.provider?.kind || '').trim();
      const number = Number(input.provider?.number);
      const provider = await readProviderArtifact(Object.freeze({ repository:authority.repository, kind, number }));
      const observedNumber = Number(provider?.number ?? provider?.id);
      if (!provider || provider.repository !== authority.repository || provider.kind !== kind || observedNumber !== number) {
        fail('PROJECT_ARTIFACT_BINDING_PROVIDER_MISMATCH', 'provider readback does not match the explicitly selected artifact identity');
      }

      const core = bindProjectArtifact({
        project_ref:projectRef,
        repository:authority.repository,
        transition_id:input.transition_id,
        authority_revision:expectedRevision,
        provider:{ kind, id:number },
        relationship:input.relationship,
        satisfaction:{ condition:input.satisfaction_condition },
      });
      const bindingRef = await bindingRefFor(core);
      const binding = Object.freeze({ ...core, binding_ref:bindingRef });
      const persisted = await appendBindingObservation(binding);
      const providerState = provider.merged === true ? 'merged' : provider.state;
      const classification = classifyProjectArtifactBinding(binding, { provider:{ repository:provider.repository, kind:provider.kind, id:observedNumber, state:providerState } });
      return Object.freeze({ ok:true, binding, provider:Object.freeze({ ...provider }), observation_ref:persisted?.observation_ref || null, classification });
    },
  });
}
