import { createProjectAuthoringGithubAdapter } from './project-authoring-github-runtime.js';
import { createProjectDefinitionChangesetWriter } from './project-definition-changeset-writer.js';
import { createProjectDefinitionMutationAuthorityPolicy } from './project-definition-mutation-authority.js';

function requireFunction(dependencies, name) {
  if (!dependencies || typeof dependencies[name] !== 'function') {
    throw new TypeError(`${name} dependency is required`);
  }
  return dependencies[name];
}

export function createProjectAuthoringProductionRuntime(dependencies = {}) {
  const resolveAuthority = requireFunction(dependencies, 'resolveAuthority');
  const readDefinitionFacts = requireFunction(dependencies, 'readDefinitionFacts');
  const readRepositoryDisposition = requireFunction(dependencies, 'readRepositoryDisposition');
  const readSourceRevision = requireFunction(dependencies, 'readSourceRevision');
  const applyChangeset = requireFunction(dependencies, 'applyChangeset');
  const deriveProjectGraph = requireFunction(dependencies, 'deriveProjectGraph');

  const mutationAuthority = createProjectDefinitionMutationAuthorityPolicy({
    readRepositoryDisposition,
    readSourceRevision,
  });
  const writeChangeset = createProjectDefinitionChangesetWriter({ applyChangeset });

  return createProjectAuthoringGithubAdapter({
    resolveAuthority,
    readDefinitionFacts,
    deriveProjectGraph,
    applyChangeset:writeChangeset,
    resolveMutationAuthority:(request) => mutationAuthority.require(request),
  });
}