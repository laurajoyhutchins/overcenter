import type { ProjectDefinitionMutationAuthority } from './project-definition-mutation-authority.js';

type ApplyChangeset = (request: Record<string, unknown>, options: { executionAuthority: { require(input: unknown): Promise<ProjectDefinitionMutationAuthority> } }) => Promise<unknown>;

type Dependencies = Readonly<{ applyChangeset: ApplyChangeset }>;

function fail(message: string, details: unknown = null): never {
  const error = new Error(message);
  Object.assign(error, { code:'PROJECT_DEFINITION_CHANGESET_AUTHORITY_MISMATCH', details });
  throw error;
}

function authorityFor(value: unknown): ProjectDefinitionMutationAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('project definition changeset requires semantic mutation authority');
  const authority = value as Record<string, unknown>;
  if (authority.schema !== 'project-definition-mutation-authority-v1' || authority.subject !== 'project_definition') {
    fail('project definition changeset authority has the wrong subject');
  }
  return authority as ProjectDefinitionMutationAuthority;
}

export function createProjectDefinitionChangesetWriter(dependencies: Dependencies) {
  if (!dependencies || typeof dependencies.applyChangeset !== 'function') throw new TypeError('applyChangeset dependency is required');
  return async function write(raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('project definition changeset request must be an object');
    const input = raw as Record<string, unknown>;
    const authority = authorityFor(input.mutation_authority);
    const repository = typeof input.repo === 'string' ? input.repo.trim() : '';
    const baseRevision = typeof input.base_sha === 'string' ? input.base_sha.trim().toLowerCase() : '';
    if (authority.repository !== repository || authority.project_ref !== `github:${repository}` || authority.authority_revision !== baseRevision) {
      fail('project definition changeset authority does not match repository source coordinates', {
        repository,
        authority_repository:authority.repository,
        base_revision:baseRevision || null,
        authority_revision:authority.authority_revision,
      });
    }
    const { mutation_authority: _ignored, lease_ref: _leaseRef, lease_token: _leaseToken, run_id: _runId, ...request } = input;
    if (_leaseRef !== undefined || _leaseToken !== undefined || _runId !== undefined) {
      fail('project definition changeset must not mix semantic source authority with execution lease bookkeeping');
    }
    return dependencies.applyChangeset(request, {
      executionAuthority:Object.freeze({
        async require(authorityRequest: unknown) {
          const requestedRepository = authorityRequest && typeof authorityRequest === 'object' && !Array.isArray(authorityRequest)
            ? String((authorityRequest as Record<string, unknown>).repository || '').trim()
            : '';
          if (requestedRepository && requestedRepository !== authority.repository) {
            fail('GitHub writer requested authority for a different repository', { requested_repository:requestedRepository, authority_repository:authority.repository });
          }
          return authority;
        },
      }),
    });
  };
}
