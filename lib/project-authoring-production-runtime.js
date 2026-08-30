import { createProjectAuthoringGithubAdapter } from './project-authoring-github-runtime.js';
import { createProjectDefinitionChangesetWriter } from './project-definition-changeset-writer.js';
import { createProjectDefinitionMutationAuthorityPolicy } from './project-definition-mutation-authority.js';

function requireFunction(dependencies, name) {
  if (!dependencies || typeof dependencies[name] !== 'function') {
    throw new TypeError(`${name} dependency is required`);
  }
  return dependencies[name];
}

function requireHostCapability(host, group, method) {
  const capability = host?.[group];
  if (!capability || typeof capability[method] !== 'function') {
    throw new TypeError(`${group}.${method} host capability is required`);
  }
  return capability[method].bind(capability);
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

export function createProjectAuthoringProductionRuntimeFromHost(host = {}) {
  return createProjectAuthoringProductionRuntime({
    resolveAuthority:requireHostCapability(host, 'projectAuthority', 'resolve'),
    readDefinitionFacts:requireHostCapability(host, 'definitionFacts', 'read'),
    readRepositoryDisposition:requireHostCapability(host, 'repositoryDisposition', 'read'),
    readSourceRevision:requireHostCapability(host, 'sourceRevision', 'read'),
    applyChangeset:requireHostCapability(host, 'githubChangeset', 'apply'),
    deriveProjectGraph:requireHostCapability(host, 'projectGraph', 'derive'),
  });
}