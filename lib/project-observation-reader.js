import { normalizeProjectRepositoryFacts } from './project-repository-facts.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function text(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail('PROJECT_OBSERVATIONS_INPUT_INVALID', `${field} must be a non-empty string`, { field });
  return normalized;
}

function exactRevision(value, field = 'revision') {
  const revision = text(value, field).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    fail('PROJECT_OBSERVATIONS_INPUT_INVALID', `${field} must be a full Git commit SHA`, { field, revision });
  }
  return revision;
}

function freezeObservation(value) {
  return Object.freeze(value);
}

export const PROJECT_OBSERVATION_KINDS = Object.freeze([
  'github.repository_revision',
  'github.pull_request',
  'github.check_run',
]);

export function createProjectObservationReader() {
  return async function readProjectObservations(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      fail('PROJECT_OBSERVATIONS_INPUT_INVALID', 'project observation input must be an object');
    }
    const allowed = new Set(['derivation', 'facts', 'nodes', 'project_ref', 'repository', 'revision']);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key)).sort();
    if (unknown.length) {
      fail('PROJECT_OBSERVATIONS_INPUT_INVALID', 'project observation input contains unsupported fields', { unknown });
    }

    const projectRef = text(input.project_ref, 'project_ref');
    const repository = text(input.repository, 'repository');
    const revision = exactRevision(input.revision);
    const facts = normalizeProjectRepositoryFacts(input.facts);
    if (facts.repository !== repository || facts.revision !== revision) {
      fail('PROJECT_OBSERVATIONS_AUTHORITY_MISMATCH', 'project facts are not attributable to the resolved exact repository revision', {
        repository,
        revision,
        facts_repository:facts.repository,
        facts_revision:facts.revision,
      });
    }

    const observations = [freezeObservation({
      schema:'project-authority-observation-v1',
      observation_key:`github.repository_revision:${repository}@${revision}`,
      kind:'github.repository_revision',
      project_ref:projectRef,
      repository,
      revision,
      default_branch:facts.default_branch,
    })];

    for (const pull of facts.pull_requests) {
      observations.push(freezeObservation({
        schema:'project-authority-observation-v1',
        observation_key:`github.pull_request:${repository}#${pull.number}@${pull.head_sha}`,
        kind:'github.pull_request',
        project_ref:projectRef,
        repository,
        revision,
        pull_request:pull.number,
        state:pull.state,
        draft:pull.draft,
        mergeable:pull.mergeable,
        head_sha:pull.head_sha,
        base_sha:pull.base_sha,
      }));
      for (const check of pull.checks) {
        observations.push(freezeObservation({
          schema:'project-authority-observation-v1',
          observation_key:`github.check_run:${repository}#${pull.number}@${pull.head_sha}:${check.name}`,
          kind:'github.check_run',
          project_ref:projectRef,
          repository,
          revision,
          pull_request:pull.number,
          head_sha:pull.head_sha,
          name:check.name,
          status:check.status,
          conclusion:check.conclusion,
        }));
      }
    }

    observations.sort((left, right) => left.observation_key.localeCompare(right.observation_key));
    return Object.freeze(observations);
  };
}
