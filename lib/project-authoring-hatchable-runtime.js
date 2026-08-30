import { db as hatchableDb } from 'hatchable';
import { applyGithubChangesetWithGitHubApp } from './github-apply-changeset.js';
import { deriveOvercenterProjectGraph } from './overcenter-project-graph-deriver.js';
import { createProjectAuthoringProductionRuntimeFromHost } from './project-authoring-production-runtime.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { createPostgresRepositoryDispositionStore } from './repository-disposition.js';

const SHA40 = /^[0-9a-f]{40}$/;

function requireMethod(value, name) {
  if (!value || typeof value[name] !== 'function') throw new TypeError(`${name} capability is required`);
  return value[name].bind(value);
}

function definitionFactsReader(graphRuntime) {
  const readProjectFacts = requireMethod(graphRuntime, 'readProjectFacts');
  return async function readDefinitionFacts({ repository, revision }) {
    const envelope = await readProjectFacts({ repository, revision });
    const observedRevision = typeof envelope?.revision === 'string' ? envelope.revision.trim().toLowerCase() : '';
    if (envelope?.schema !== 'project-authority-facts-v1'
        || envelope?.repository !== repository
        || observedRevision !== String(revision || '').trim().toLowerCase()
        || !SHA40.test(observedRevision)
        || !envelope?.facts?.definition_facts) {
      throw new TypeError('project graph runtime did not return exact authoritative definition facts');
    }
    return envelope.facts.definition_facts;
  };
}

export function createHatchableProjectAuthoringRuntime(options = {}) {
  const dbBinding = options.db || hatchableDb;
  const graphRuntime = options.graphRuntime || createGitHubProjectGraphRuntime({ db:dbBinding });
  const resolveProjectAuthority = requireMethod(graphRuntime, 'resolveProjectAuthority');
  const repositoryDisposition = options.repositoryLifecycle || createPostgresRepositoryDispositionStore(dbBinding);
  const readRepositoryDisposition = requireMethod(repositoryDisposition, options.repositoryLifecycle ? 'observe' : 'get');
  const applyGithubChangeset = typeof options.applyGithubChangeset === 'function'
    ? options.applyGithubChangeset
    : (request, runtimeOptions = {}) => applyGithubChangesetWithGitHubApp(request, { ...runtimeOptions, db:dbBinding });
  const deriveProjectGraph = typeof options.deriveProjectGraph === 'function'
    ? options.deriveProjectGraph
    : deriveOvercenterProjectGraph;

  return createProjectAuthoringProductionRuntimeFromHost({
    projectAuthority:{ resolve:resolveProjectAuthority },
    definitionFacts:{ read:definitionFactsReader(graphRuntime) },
    repositoryDisposition:{
      async read(repository) {
        const disposition = await readRepositoryDisposition(repository);
        if (!disposition) throw new TypeError('repository disposition is unavailable');
        return disposition;
      },
    },
    githubChangeset:{ apply:applyGithubChangeset },
    projectGraph:{ derive:deriveProjectGraph },
  });
}
