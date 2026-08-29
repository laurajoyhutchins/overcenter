import { canonicalJson, sha256Text } from './canonical-json.js';
import { canonicalProjectDefinition } from './project-authoring.js';
import { amendProjectDefinition } from './project-authoring-runtime.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function requireFunction(dependencies, name) {
  if (!dependencies || typeof dependencies[name] !== 'function') {
    fail('PROJECT_AUTHORING_ADAPTER_INVALID', `${name} dependency is required`);
  }
  return dependencies[name];
}

function selectDefinition(facts, projectRef) {
  const candidates = [];
  for (const entry of Array.isArray(facts?.definitions) ? facts.definitions : []) {
    if (typeof entry?.content !== 'string' || typeof entry?.path !== 'string') continue;
    let parsed;
    try { parsed = JSON.parse(entry.content); } catch { continue; }
    try {
      const definition = canonicalProjectDefinition(parsed);
      if (definition.project_ref === projectRef) candidates.push({ path:entry.path, definition });
    } catch {
      // Non-project definition files are irrelevant to semantic selection.
    }
  }
  if (candidates.length !== 1) {
    fail('PROJECT_AUTHORING_DEFINITION_AMBIGUOUS', 'exactly one authoritative project definition must match project_ref', {
      project_ref:projectRef,
      observed:candidates.length,
    });
  }
  return candidates[0];
}

export async function projectAuthoringIdempotencyKey(input) {
  const digest = await sha256Text(canonicalJson({
    operation:'project.amend',
    project_ref:input?.project_ref,
    expected_revision:input?.expected_revision,
    amendment:input?.amendment,
  }));
  return `project-amend-v1:${digest}`;
}

export function createProjectAuthoringGithubAdapter(dependencies = {}) {
  const resolveAuthority = requireFunction(dependencies, 'resolveAuthority');
  const readDefinitionFacts = requireFunction(dependencies, 'readDefinitionFacts');
  const resolveMutationBranch = requireFunction(dependencies, 'resolveMutationBranch');
  const applyChangeset = requireFunction(dependencies, 'applyChangeset');
  const deriveProjectGraph = requireFunction(dependencies, 'deriveProjectGraph');

  return Object.freeze({
    async amend(input = {}) {
      let selectedPath = null;
      return amendProjectDefinition(input, {
        resolveAuthority,
        async readDefinition(authority) {
          const facts = await readDefinitionFacts({ repository:authority.repository, revision:authority.revision });
          const selected = selectDefinition(facts, input.project_ref);
          selectedPath = selected.path;
          return selected.definition;
        },
        async mutateDefinition(request) {
          if (!selectedPath) fail('PROJECT_AUTHORING_DEFINITION_UNRESOLVED', 'definition path was not resolved from authoritative facts');
          const branch = await resolveMutationBranch({ authority:{ kind:'github', repository:request.repository, revision:request.expected_revision, derivation:request.derivation }, project_ref:request.project_ref });
          if (!branch || typeof branch.branch !== 'string' || !branch.branch.trim()) {
            fail('PROJECT_AUTHORING_MUTATION_BRANCH_INVALID', 'mutation branch resolver must return a branch');
          }
          const idempotencyKey = await projectAuthoringIdempotencyKey(input);
          const result = await applyChangeset({
            repo:request.repository,
            base_sha:request.expected_revision,
            branch:branch.branch,
            expected_head:branch.expected_head || request.expected_revision,
            changes:[{ path:selectedPath, operation:branch.operation || 'update', content:`${JSON.stringify(request.definition, null, 2)}\n` }],
            commit_message:branch.commit_message || `project: amend ${request.project_ref}`,
            idempotency_key:idempotencyKey,
            ...(input.lease_ref ? { lease_ref:input.lease_ref } : {}),
            ...(input.run_id ? { run_id:input.run_id } : {}),
          });
          if (!result?.ok || !/^[0-9a-f]{40}$/.test(String(result.new_head || result.commit_sha || ''))) {
            fail('PROJECT_AUTHORING_MUTATION_UNCONFIRMED', 'GitHub project definition mutation did not return a confirmed exact revision', { result });
          }
          return { revision:String(result.new_head || result.commit_sha).toLowerCase(), idempotency_key:idempotencyKey };
        },
        async deriveProjectGraph(authority) {
          const facts = await readDefinitionFacts({ repository:authority.repository, revision:authority.revision });
          return deriveProjectGraph({ project_ref:input.project_ref, authority, facts:{ definition_facts:facts } });
        },
      });
    },
  });
}