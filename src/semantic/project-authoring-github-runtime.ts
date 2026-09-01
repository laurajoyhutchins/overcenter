import { canonicalJson, sha256Text } from './canonical-json.js';
import { canonicalProjectDefinition } from './project-authoring.js';
import type { CanonicalProjectDefinition } from './project-authoring.js';
import { amendProjectDefinition, defineProjectDefinition } from './project-authoring-runtime.js';
import type {
  ProjectAmendRequest,
  ProjectAuthoringAuthority,
  ProjectAuthoringMutationRequest,
  ProjectDefineRequest,
} from './project-authoring-runtime.js';
import { projectAuthoringWorkBranch } from './project-authoring-work-branch.js';
import type {
  ProjectDefinitionMutationAuthority,
  ProjectDefinitionMutationOperation,
} from './project-definition-mutation-authority.js';

const DISCOVERY_PATH = '.overcenter/project-definitions.json';
const DEFINITION_DIRECTORY = '.overcenter/definitions';

type ProjectAuthoringGithubError = Error & {
  code?: string;
  details?: unknown;
  may_have_mutated?: boolean;
};

type DefinitionFact = Readonly<{
  path?: unknown;
  content?: unknown;
}>;

type DefinitionFacts = Readonly<{
  definitions?: readonly DefinitionFact[];
}>;

type ChangesetResult = Readonly<Record<string, unknown>> & {
  ok?: unknown;
  new_head?: unknown;
  commit_sha?: unknown;
  error?: unknown;
  may_have_mutated?: unknown;
  details?: unknown;
};

type LegacyMutationAuthority = Readonly<{
  lease_ref?: string;
  run_id?: string;
}>;

type ProjectAuthoringAdapterInput = LegacyMutationAuthority;

type ResolveAuthority = (
  input: Readonly<{ project_ref: string }>,
) => Promise<ProjectAuthoringAuthority>;

type ReadDefinitionFacts = (
  input: Readonly<{ repository: string; revision: string }>,
) => Promise<DefinitionFacts>;

type ApplyChangeset = (
  request: Readonly<Record<string, unknown>>,
) => Promise<ChangesetResult>;

type DeriveProjectGraph = (
  input: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

type ReadProjectObservations = (
  input: Readonly<{
    project_ref: string;
    repository: string;
    revision: string;
    derivation: string;
  }>,
) => Promise<unknown>;

type ResolveMutationAuthority = (
  input: Readonly<{
    operation: ProjectDefinitionMutationOperation;
    project_ref: string;
    repository: string;
    expected_revision: string;
  }>,
) => Promise<unknown>;

export type ProjectAuthoringGithubDependencies = Readonly<{
  resolveAuthority?: ResolveAuthority;
  readDefinitionFacts?: ReadDefinitionFacts;
  applyChangeset?: ApplyChangeset;
  deriveProjectGraph?: DeriveProjectGraph;
  readProjectObservations?: ReadProjectObservations;
  resolveMutationAuthority?: ResolveMutationAuthority;
}>;

type ProjectDefinitionCandidate = Readonly<{
  path: string;
  definition: CanonicalProjectDefinition;
}>;

type NormalizedMutationAuthority =
  | Readonly<{ mutation_authority: ProjectDefinitionMutationAuthority }>
  | Readonly<{ lease_ref: string; run_id?: string }>;

function fail(code: string, message: string, details: unknown = null): never {
  const error = new Error(message) as ProjectAuthoringGithubError;
  error.code = code;
  error.details = details;
  throw error;
}

function requireFunction<T>(
  dependencies: ProjectAuthoringGithubDependencies,
  name: keyof ProjectAuthoringGithubDependencies,
): T {
  const candidate = dependencies?.[name];
  if (typeof candidate !== 'function') {
    fail('PROJECT_AUTHORING_ADAPTER_INVALID', `${name} dependency is required`);
  }
  return candidate as T;
}

function definitionCandidates(facts: DefinitionFacts | null | undefined, projectRef: string): ProjectDefinitionCandidate[] {
  const candidates: ProjectDefinitionCandidate[] = [];
  for (const entry of Array.isArray(facts?.definitions) ? facts.definitions : []) {
    if (typeof entry?.content !== 'string' || typeof entry?.path !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.content);
    } catch {
      continue;
    }
    try {
      const definition = canonicalProjectDefinition(parsed);
      if (definition.project_ref === projectRef) {
        candidates.push({ path:entry.path, definition });
      }
    } catch {}
  }
  return candidates;
}

function selectDefinition(facts: DefinitionFacts, projectRef: string): ProjectDefinitionCandidate {
  const candidates = definitionCandidates(facts, projectRef);
  if (candidates.length !== 1) {
    fail('PROJECT_AUTHORING_DEFINITION_AMBIGUOUS', 'exactly one authoritative project definition must match project_ref', {
      project_ref:projectRef,
      observed:candidates.length,
    });
  }
  return candidates[0]!;
}

function bootstrapDefinitionPath(projectRef: string): string {
  const repositoryName = String(projectRef || '').split('/').pop() || '';
  if (!/^[A-Za-z0-9_.-]+$/.test(repositoryName)) {
    fail('PROJECT_AUTHORING_DEFINITION_PATH_INVALID', 'project_ref cannot be mapped to a bounded repository-owned definition path', {
      project_ref:projectRef,
    });
  }
  return `${DEFINITION_DIRECTORY}/${repositoryName}.json`;
}

function explicitMutationCertainty(value: unknown): boolean | null {
  const result = value as {
    may_have_mutated?: unknown;
    details?: { may_have_mutated?: unknown } | null;
  } | null | undefined;
  const certainty = result?.may_have_mutated ?? result?.details?.may_have_mutated;
  return certainty === undefined ? null : Boolean(certainty);
}

function mutationCertainty(result: ChangesetResult): boolean {
  const explicit = explicitMutationCertainty(result);
  return explicit === null ? String(result?.error || '').includes('INDETERMINATE') : explicit;
}

function mutationBoundaryFailure(errorInput: unknown): ProjectAuthoringGithubError {
  const error = errorInput instanceof Error
    ? errorInput as ProjectAuthoringGithubError
    : new Error(String(
        errorInput && typeof errorInput === 'object' && !Array.isArray(errorInput)
          ? (errorInput as Record<string, unknown>).message || errorInput
          : errorInput || 'GitHub project definition mutation failed',
      )) as ProjectAuthoringGithubError;
  if (!(errorInput instanceof Error) && errorInput && typeof errorInput === 'object' && !Array.isArray(errorInput)) {
    const input = errorInput as Record<string, unknown>;
    if (input.code != null) error.code = input.code as string;
    if (input.details != null) error.details = input.details;
  }
  const explicit = explicitMutationCertainty(errorInput);
  const mayHaveMutated = explicit === null ? true : explicit;
  const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : {};
  error.may_have_mutated = mayHaveMutated;
  error.details = Object.freeze({ ...details, may_have_mutated:mayHaveMutated });
  return error;
}

async function applyAtMutationBoundary(
  applyChangeset: ApplyChangeset,
  request: Readonly<Record<string, unknown>>,
): Promise<ChangesetResult> {
  try {
    return await applyChangeset(request);
  } catch (error) {
    throw mutationBoundaryFailure(error);
  }
}

function confirmedRevision(result: ChangesetResult): string {
  const revision = String(result?.new_head || result?.commit_sha || '').toLowerCase();
  if (!result?.ok || !/^[0-9a-f]{40}$/.test(revision)) {
    const mayHaveMutated = mutationCertainty(result);
    const error = new Error('GitHub project definition mutation did not return a confirmed exact revision') as ProjectAuthoringGithubError;
    error.code = 'PROJECT_AUTHORING_MUTATION_UNCONFIRMED';
    error.may_have_mutated = mayHaveMutated;
    error.details = Object.freeze({ result, may_have_mutated:mayHaveMutated });
    throw error;
  }
  return revision;
}

function normalizedMutationAuthority(
  authorityInput: unknown,
  operation: ProjectDefinitionMutationOperation,
  request: ProjectAuthoringMutationRequest,
): NormalizedMutationAuthority {
  const authority = authorityInput as Partial<ProjectDefinitionMutationAuthority> & LegacyMutationAuthority | null | undefined;
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
      fail('PROJECT_AUTHORING_MUTATION_AUTHORITY_INVALID', 'project definition source mutation authority does not match semantic mutation coordinates', {
        operation,
        expected,
      });
    }
    return Object.freeze({
      mutation_authority:Object.freeze({
        schema:'project-definition-mutation-authority-v1',
        subject:'project_definition',
        operation:authority.operation,
        project_ref:authority.project_ref,
        repository:authority.repository,
        authority_revision:expected.authority_revision,
      }) as ProjectDefinitionMutationAuthority,
    });
  }
  const leaseRef = typeof authority?.lease_ref === 'string' ? authority.lease_ref.trim() : '';
  if (!leaseRef) {
    fail('PROJECT_AUTHORING_MUTATION_AUTHORITY_INVALID', 'project authoring mutation authority must resolve semantic source authority or a compatibility lease_ref', {
      operation,
    });
  }
  const runId = typeof authority?.run_id === 'string' ? authority.run_id.trim() : '';
  return Object.freeze({ lease_ref:leaseRef, ...(runId ? { run_id:runId } : {}) });
}

export async function projectAuthoringIdempotencyKey(input: ProjectAmendRequest): Promise<string> {
  const digest = await sha256Text(canonicalJson({
    operation:'project.amend',
    project_ref:input?.project_ref,
    expected_revision:input?.expected_revision,
    amendment:input?.amendment,
  }));
  return `project-amend-v1:${digest}`;
}

export async function projectDefinitionIdempotencyKey(input: ProjectDefineRequest): Promise<string> {
  const definition = canonicalProjectDefinition(input?.definition);
  const digest = await sha256Text(canonicalJson({
    operation:'project.define',
    project_ref:input?.project_ref,
    expected_revision:input?.expected_revision,
    definition,
  }));
  return `project-define-v1:${digest}`;
}

export function createProjectAuthoringGithubAdapter(dependencies: ProjectAuthoringGithubDependencies = {}) {
  const resolveAuthority = requireFunction<ResolveAuthority>(dependencies, 'resolveAuthority');
  const readDefinitionFacts = requireFunction<ReadDefinitionFacts>(dependencies, 'readDefinitionFacts');
  const applyChangeset = requireFunction<ApplyChangeset>(dependencies, 'applyChangeset');
  const deriveProjectGraph = requireFunction<DeriveProjectGraph>(dependencies, 'deriveProjectGraph');
  const readProjectObservations = typeof dependencies.readProjectObservations === 'function'
    ? dependencies.readProjectObservations
    : null;
  const resolveMutationAuthority = typeof dependencies.resolveMutationAuthority === 'function'
    ? dependencies.resolveMutationAuthority
    : null;

  const deriveAtResult = (input: Readonly<{ project_ref: string }>) => async (authority: ProjectAuthoringAuthority) => {
    const facts = await readDefinitionFacts({ repository:authority.repository, revision:authority.revision });
    return deriveProjectGraph({ project_ref:input.project_ref, authority, facts:{ definition_facts:facts } });
  };

  const mutationAuthorityFor = async (
    operation: ProjectDefinitionMutationOperation,
    input: ProjectAuthoringAdapterInput,
    request: ProjectAuthoringMutationRequest,
  ): Promise<NormalizedMutationAuthority | Readonly<Record<string, never>>> => {
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
    return legacy.lease_ref
      ? normalizedMutationAuthority(legacy, operation, request)
      : Object.freeze({});
  };

  return Object.freeze({
    async define(input: ProjectDefineRequest & ProjectAuthoringAdapterInput = {} as ProjectDefineRequest & ProjectAuthoringAdapterInput) {
      let definitionPath: string | null = null;
      return defineProjectDefinition(input, {
        resolveAuthority,
        async readDefinition(authority) {
          const facts = await readDefinitionFacts({ repository:authority.repository, revision:authority.revision });
          const matches = definitionCandidates(facts, input.project_ref);
          if (matches.length > 1) {
            fail('PROJECT_AUTHORING_DEFINITION_AMBIGUOUS', 'multiple authoritative project definitions match project_ref', {
              project_ref:input.project_ref,
              observed:matches.length,
            });
          }
          if (matches.length === 1) return matches[0]!.definition;
          if (Array.isArray(facts?.definitions) && facts.definitions.length > 0) {
            fail('PROJECT_AUTHORING_BOOTSTRAP_AMBIGUOUS', 'project.define bootstrap currently requires an empty authoritative definition inventory', {
              project_ref:input.project_ref,
              observed:facts.definitions.length,
            });
          }
          definitionPath = bootstrapDefinitionPath(input.project_ref);
          return null;
        },
        async mutateDefinition(request) {
          if (!definitionPath) {
            fail('PROJECT_AUTHORING_DEFINITION_UNRESOLVED', 'bootstrap definition path was not resolved from semantic project identity');
          }
          const mutationAuthority = await mutationAuthorityFor('define', input, request);
          const idempotencyKey = await projectDefinitionIdempotencyKey(input);
          const branch = projectAuthoringWorkBranch({ operation:'define', idempotency_key:idempotencyKey });
          const discovery = { schema:'project-definition-discovery-v1', definitions:[definitionPath] };
          const result = await applyAtMutationBoundary(applyChangeset, {
            repo:request.repository,
            base_sha:request.expected_revision,
            branch,
            expected_head:request.expected_revision,
            changes:[
              {
                path:DISCOVERY_PATH,
                operation:'create',
                content:`${JSON.stringify(discovery, null, 2)}\n`,
              },
              {
                path:definitionPath,
                operation:'create',
                content:`${JSON.stringify(request.definition, null, 2)}\n`,
              },
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

    async amend(input: ProjectAmendRequest & ProjectAuthoringAdapterInput = {} as ProjectAmendRequest & ProjectAuthoringAdapterInput) {
      let selectedPath: string | null = null;
      return amendProjectDefinition(input, {
        resolveAuthority,
        async readDefinition(authority) {
          const facts = await readDefinitionFacts({ repository:authority.repository, revision:authority.revision });
          const selected = selectDefinition(facts, input.project_ref);
          selectedPath = selected.path;
          return selected.definition;
        },
        ...(readProjectObservations
          ? {
              readProjectObservations:async (authority: ProjectAuthoringAuthority) => readProjectObservations({
                project_ref:input.project_ref,
                repository:authority.repository,
                revision:authority.revision,
                derivation:authority.derivation,
              }),
            }
          : {}),
        async mutateDefinition(request) {
          if (!selectedPath) {
            fail('PROJECT_AUTHORING_DEFINITION_UNRESOLVED', 'definition path was not resolved from authoritative facts');
          }
          const mutationAuthority = await mutationAuthorityFor('amend', input, request);
          const idempotencyKey = await projectAuthoringIdempotencyKey(input);
          const branch = projectAuthoringWorkBranch({ operation:'amend', idempotency_key:idempotencyKey });
          const result = await applyAtMutationBoundary(applyChangeset, {
            repo:request.repository,
            base_sha:request.expected_revision,
            branch,
            expected_head:request.expected_revision,
            changes:[
              {
                path:selectedPath,
                operation:'update',
                content:`${JSON.stringify(request.definition, null, 2)}\n`,
              },
            ],
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
