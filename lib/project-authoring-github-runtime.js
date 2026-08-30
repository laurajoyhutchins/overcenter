import { canonicalJson, sha256Text } from './canonical-json.js';
import { canonicalProjectDefinition } from './project-authoring.js';
import { amendProjectDefinition, defineProjectDefinition } from './project-authoring-runtime.js';
import { projectAuthoringWorkBranch } from './project-authoring-work-branch.js';

const DISCOVERY_PATH = '.overcenter/project-definitions.json';
const DEFINITION_DIRECTORY = '.overcenter/definitions';

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

function definitionCandidates(facts, projectRef) {
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
  return candidates;
}

function selectDefinition(facts, projectRef) {
  const candidates = definitionCandidates(facts, projectRef);
  if (candidates.length !== 1) {
    fail('PROJECT_AUTHORING_DEFINITION_AMBIGUOUS', 'exactly one authoritative project definition must match project_ref', {
      project_ref:projectRef,
      observed:candidates.length,
    });
  }
  return candidates[0];
}

function bootstrapDefinitionPath(projectRef) {
  const repositoryName = String(projectRef || '').split('/').pop() || '';
  if (!/^[A-Za-z0-9_.-]+$/.test(repositoryName)) {
    fail('PROJECT_AUTHORING_DEFINITION_PATH_INVALID', 'project_ref cannot be mapped to a bounded repository-owned definition path', { project_ref:projectRef });
  }
  return `${DEFINITION_DIRECTORY}/${repositoryName}.json`;
}

function confirmedRevision(result) {
  const revision = String(result?.new_head || result?.commit_sha || '').toLowerCase();
  if (!result?.ok || !/^[0-9a-f]{40}$/.test(revision)) {
    fail('PROJECT_AUTHORING_MUTATION_UNCONFIRMED', 'GitHub project definition mutation did not return a confirmed exact revision', { result });
  }
  return revision;
}

function normalizedMutationAuthority(authority, operation, request = {}) {
  if (authority?.schema === 'project-definition-mutation-authority-v1' || authority?.subject === 'project_definition') {
    const expected = {
      operation,
      project_ref:request.project_ref,
      repository:request.repository,
      authority_revision:String(request.expected_revision || '').toLowerCase(),
    };
    if (authority?.schema !== 'project-definition-mutation-authority-v1'
        || authority?.subject !== 'project_definition'
        || authority?.operation !== expected.operation
        || authority?.project_ref !== expected.project_ref
        || authority?.repository !== expected.repository
        || String(authority?.authority_revision || '').toLowerCase() !== expected.authority_revision) {
      fail('PROJECT_AUTHORING_MUTATION_AUTHORITY_INVALID', 'project definition source mutation authority does not match semantic mutation coordinates', { operation, expected });
    }
    return Object.freeze({ mutation_authority:Object.freeze({
      schema:'project-definition-mutation-authority-v1',
      subject:'project_definition',
      operation:authority.operation,
      project_ref:authority.project_ref,
      repository:authority.repository,
      authority_revision:expected.authority_revision,
    }) });
  }
  const leaseRef = typeof authority?.lease_ref === 'string' ? authority.lease_ref.trim() : '';
  if (!leaseRef) {
    fail('PROJECT_AUTHORING_MUTATION_AUTHORITY_INVALID', 'project authoring mutation authority must resolve semantic source authority or a compatibility lease_ref', { operation });
  }
  const runId = typeof authority?.run_id === 'string' ? authority.run_id.trim() : '';
  return Object.freeze({ lease_ref:leaseRef, ...(runId ? { run_id:runId } : {}) });
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

export async function projectDefinitionIdempotencyKey(input) {
  const definition = canonicalProjectDefinition(input?.definition);
  const digest = await sha256Text(canonicalJson({
    operation:'project.define',
    project_ref:input?.project_ref,
    expected_revision:input?.expected_revision,
    definition,
  }));
  return `project-define-v1:${digest}`;
}

export function createProjectAuthoringGithubAdapter(dependencies = {}) {
  const resolveAuthority = requireFunction(dependencies, 'resolveAuthority');
  const readDefinitionFacts = requireFunction(dependencies, 'readDefinitionFacts');
  const applyChangeset = requireFunction(dependencies, 'applyChangeset');
  const deriveProjectGraph = requireFunction(dependencies, 'deriveProjectGraph');
  const resolveMutationAuthority = typeof dependencies.resolveMutationAuthority === 'function'
    ? dependencies.resolveMutationAuthority
    : null;

  const deriveAtResult = (input) => async (authority) => {
    const facts = await readDefinitionFacts({ repository:authority.repository, revision:authority.revision });
    return deriveProjectGraph({ project_ref:input.project_ref, authority, facts:{ definition_facts:facts } });
  };

  const mutationAuthorityFor = async (operation, input, request) => {
    if (resolveMutationAuthority) {
      return normalizedMutationAuthority(await resolveMutationAuthority({
        operation,
        project_ref:request.project_ref,
        repository:request.repository,
        expected_revision:request.expected_revision,
      }), operation, request);
    }
    const legacy = {
      ...(input?.lease_ref ? { lease_ref:input.lease_ref } : {}),
      ...(input?.run_id ? { run_id:input.run_id } : {}),
    };
    return legacy.lease_ref ? normalizedMutationAuthority(legacy, operation, request) : Object.freeze({});
  };

  return Object.freeze({
    async define(input = {}) {
      let definitionPath = null;
      return defineProjectDefinition(input, {
        resolveAuthority,
        async readDefinition(authority) {
          const facts = await readDefinitionFacts({ repository:authority.repository, revision:authority.revision });
          const matches = definitionCandidates(facts, input.project_ref);
          if (matches.length > 1) {
            fail('PROJECT_AUTHORING_DEFINITION_AMBIGUOUS', 'multiple authoritative project definitions match project_ref', { project_ref:input.project_ref, observed:matches.length });
          }
          if (matches.length === 1) return matches[0].definition;
          if (Array.isArray(facts?.definitions) && facts.definitions.length > 0) {
            fail('PROJECT_AUTHORING_BOOTSTRAP_AMBIGUOUS', 'project.define bootstrap currently requires an empty authoritative definition inventory', { project_ref:input.project_ref, observed:facts.definitions.length });
          }
          definitionPath = bootstrapDefinitionPath(input.project_ref);
          return null;
        },
        async mutateDefinition(request) {
          if (!definitionPath) fail('PROJECT_AUTHORING_DEFINITION_UNRESOLVED', 'bootstrap definition path was not resolved from semantic project identity');
          const mutationAuthority = await mutationAuthorityFor('define', input, request);
          const idempotencyKey = await projectDefinitionIdempotencyKey(input);
          const branch = projectAuthoringWorkBranch({ operation:'define', idempotency_key:idempotencyKey });
          const discovery = { schema:'project-definition-discovery-v1', definitions:[definitionPath] };
          const result = await applyChangeset({
            repo:request.repository,
            base_sha:request.expected_revision,
            branch,
            expected_head:request.expected_revision,
            changes:[
              { path:DISCOVERY_PATH, operation:'create', content:`${JSON.stringify(discovery, null, 2)}\n` },
              { path:definitionPath, operation:'create', content:`${JSON.stringify(request.definition, null, 2)}\n` },
            ],
            commit_message:`project: define ${request.project_ref}`,
            idempotency_key:idempotencyKey,
            ...mutationAuthority,
          });
          return { revision:confirmedRevision(result), idempotency_key:idempotencyKey };
        },
        deriveProjectGraph:deriveAtResult(input),
      });
    },
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
          const mutationAuthority = await mutationAuthorityFor('amend', input, request);
          const idempotencyKey = await projectAuthoringIdempotencyKey(input);
          const branch = projectAuthoringWorkBranch({ operation:'amend', idempotency_key:idempotencyKey });
          const result = await applyChangeset({
            repo:request.repository,
            base_sha:request.expected_revision,
            branch,
            expected_head:request.expected_revision,
            changes:[{ path:selectedPath, operation:'update', content:`${JSON.stringify(request.definition, null, 2)}\n` }],
            commit_message:`project: amend ${request.project_ref}`,
            idempotency_key:idempotencyKey,
            ...mutationAuthority,
          });
          return { revision:confirmedRevision(result), idempotency_key:idempotencyKey };
        },
        deriveProjectGraph:deriveAtResult(input),
      });
    },
  });
}