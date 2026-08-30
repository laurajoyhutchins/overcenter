import { createProjectAuthoringGithubAdapter } from './project-authoring-github-runtime.js';
import { createProjectDefinitionChangesetWriter } from './project-definition-changeset-writer.js';
import { createProjectDefinitionMutationAuthorityPolicy } from './project-definition-mutation-authority.js';

const SHA40 = /^[0-9a-f]{40}$/;

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

function sourceRevisionReaderFromAuthority(resolveAuthority) {
  return async function readSourceRevision(repository) {
    const authority = await resolveAuthority({ project_ref:`github:${repository}` });
    const revision = typeof authority?.revision === 'string' ? authority.revision.trim().toLowerCase() : '';
    if (authority?.kind !== 'github' || authority?.repository !== repository || !SHA40.test(revision)) {
      throw new TypeError('projectAuthority.resolve did not confirm exact source authority');
    }
    return revision;
  };
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
  const resolveAuthority = requireHostCapability(host, 'projectAuthority', 'resolve');
  return createProjectAuthoringProductionRuntime({
    resolveAuthority,
    readDefinitionFacts:requireHostCapability(host, 'definitionFacts', 'read'),
    readRepositoryDisposition:requireHostCapability(host, 'repositoryDisposition', 'read'),
    readSourceRevision:sourceRevisionReaderFromAuthority(resolveAuthority),
    applyChangeset:requireHostCapability(host, 'githubChangeset', 'apply'),
    deriveProjectGraph:requireHostCapability(host, 'projectGraph', 'derive'),
  });
}
