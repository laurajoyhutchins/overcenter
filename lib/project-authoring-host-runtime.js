import { createProjectAuthoringProductionRuntimeFromHost } from './project-authoring-production-runtime.js';

const SHA40 = /^[0-9a-f]{40}$/;

function requireMethod(value, name) {
  if (!value || typeof value[name] !== 'function') throw new TypeError(`${name} capability is required`);
  return value[name].bind(value);
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} capability is required`);
  return value;
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

export function createProjectAuthoringHostRuntime(options = {}) {
  const graphRuntime = options.graphRuntime;
  const resolveProjectAuthority = requireMethod(graphRuntime, 'resolveProjectAuthority');
  const readRepositoryDisposition = requireFunction(options.readRepositoryDisposition, 'readRepositoryDisposition');
  const applyGithubChangeset = requireFunction(options.applyGithubChangeset, 'applyGithubChangeset');
  const deriveProjectGraph = requireFunction(options.deriveProjectGraph, 'deriveProjectGraph');

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
