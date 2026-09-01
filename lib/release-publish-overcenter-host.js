import { db as hatchableDb } from 'hatchable';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { canonicalProjectDefinition } from './project-authoring.js';
import { OVERCENTER_PROJECT_DEFINITION_PATH } from './overcenter-project-graph-deriver.js';
import { createGithubReleaseWithGitHubApp } from './github-release-runtime.js';
import { publishReleasePlan } from './release-publish-operation.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function exactDefinitionTransitions(envelope, projectRef, authority) {
  if (!envelope || envelope.schema !== 'project-authority-facts-v1'
      || envelope.repository !== authority.repository
      || String(envelope.revision || '').toLowerCase() !== authority.revision) {
    fail('RELEASE_PUBLISH_DEFINITION_FACTS_MISMATCH', 'release publication facts do not match exact plan authority');
  }
  const facts = envelope.facts?.definition_facts;
  if (!facts || facts.schema !== 'project-definition-facts-v1'
      || facts.repository !== authority.repository
      || String(facts.revision || '').toLowerCase() !== authority.revision) {
    fail('RELEASE_PUBLISH_DEFINITION_FACTS_MISMATCH', 'release publication definition facts are not attributable to exact authority');
  }
  const matches = (Array.isArray(facts.definitions) ? facts.definitions : [])
    .filter((entry) => entry?.path === OVERCENTER_PROJECT_DEFINITION_PATH);
  if (matches.length !== 1 || typeof matches[0]?.content !== 'string') {
    fail('RELEASE_PUBLISH_DEFINITION_UNAVAILABLE', 'exactly one repository-owned Overcenter project definition is required');
  }
  let parsed;
  try { parsed = JSON.parse(matches[0].content); }
  catch { fail('RELEASE_PUBLISH_DEFINITION_INVALID', 'repository-owned project definition must be valid JSON'); }
  const definition = canonicalProjectDefinition(parsed);
  if (definition.project_ref !== projectRef) {
    fail('RELEASE_PUBLISH_DEFINITION_SCOPE_MISMATCH', 'repository-owned project definition does not match release plan project');
  }
  return definition.transitions.map((transition) => Object.freeze({
    id:transition.id,
    ...(transition.version_impact ? { version_impact:transition.version_impact } : {}),
  }));
}

export function releasePublishingFor(options = {}) {
  const db = options.db || hatchableDb;
  const graphRuntime = options.graphRuntime || createGitHubProjectGraphRuntime({ db });
  const createRelease = options.createRelease || ((request) => createGithubReleaseWithGitHubApp(request, { db }));
  return Object.freeze({
    async publish(input) {
      return publishReleasePlan(input, {
        resolveAuthority:({ project_ref }) => graphRuntime.resolveProjectAuthority({ project_ref }),
        async readTransitions({ project_ref, authority }) {
          const facts = await graphRuntime.readProjectFacts({
            project_ref,
            repository:authority.repository,
            revision:authority.revision,
          });
          return exactDefinitionTransitions(facts, project_ref, authority);
        },
        createRelease,
      });
    },
  });
}
