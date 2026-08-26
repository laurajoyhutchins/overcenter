import { normalizeProjectRepositoryFacts } from './project-repository-facts.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;
const API_HEADERS = Object.freeze({
  Accept:'application/vnd.github+json',
  'X-GitHub-Api-Version':'2026-03-10',
  'User-Agent':'Overcenter/1.0',
});

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function requireCoordinate(repositoryInput, revisionInput) {
  const repository = String(repositoryInput || '').trim();
  const revision = String(revisionInput || '').trim().toLowerCase();
  if (!REPO.test(repository) || !SHA40.test(revision)) {
    fail('PROJECT_REPOSITORY_FACTS_READ_INVALID', 'repository and exact revision are required', { repository, revision });
  }
  return { repository, revision };
}

function encodeRepository(repository) {
  return repository.split('/').map(encodeURIComponent).join('/');
}

async function read(apiClient, path, query = undefined) {
  let response;
  try {
    response = await apiClient.call('github', {
      method:'GET',
      path,
      ...(query ? { query } : {}),
      headers:API_HEADERS,
    });
  } catch (error) {
    fail('PROJECT_REPOSITORY_FACTS_READ_FAILED', 'GitHub project facts read failed', {
      path,
      github_message:String(error?.message || error),
    });
  }
  if (Number(response?.status || 0) !== 200) {
    fail('PROJECT_REPOSITORY_FACTS_READ_FAILED', 'GitHub project facts read returned a non-success status', {
      path,
      upstream_status:Number(response?.status || 0) || null,
    });
  }
  return response.body;
}

export function createProjectRepositoryFactsReader(apiClient) {
  if (!apiClient || typeof apiClient.call !== 'function') {
    throw new Error('A GitHub API transport is required.');
  }

  return async function readProjectFacts(input = {}) {
    const { repository, revision } = requireCoordinate(input.repository, input.revision);
    const repoPath = `/repos/${encodeRepository(repository)}`;

    const repositoryBody = await read(apiClient, repoPath);
    const defaultBranch = String(repositoryBody?.default_branch || '').trim();
    if (!defaultBranch) {
      fail('PROJECT_REPOSITORY_FACTS_READ_FAILED', 'GitHub did not return the repository default branch', { repository });
    }

    const revisionBody = await read(apiClient, `${repoPath}/commits/${revision}`);
    if (String(revisionBody?.sha || '').toLowerCase() !== revision) {
      fail('PROJECT_REPOSITORY_FACTS_READ_FAILED', 'GitHub could not attribute the requested exact revision', { repository, revision });
    }

    const pullList = await read(apiClient, `${repoPath}/pulls`, { state:'open', per_page:100 });
    if (!Array.isArray(pullList)) {
      fail('PROJECT_REPOSITORY_FACTS_READ_FAILED', 'GitHub pull request inventory is invalid', { repository });
    }
    if (pullList.length >= 100) {
      fail('PROJECT_REPOSITORY_FACTS_INCOMPLETE', 'Open pull request inventory may be truncated', { repository, observed:pullList.length });
    }

    const pullRequests = [];
    for (const pull of pullList) {
      const number = Number(pull?.number);
      if (!Number.isInteger(number) || number < 1) {
        fail('PROJECT_REPOSITORY_FACTS_READ_FAILED', 'GitHub returned an invalid pull request identity', { repository });
      }
      const headSha = String(pull?.head?.sha || '').toLowerCase();
      const baseSha = String(pull?.base?.sha || '').toLowerCase();
      if (!SHA40.test(headSha) || !SHA40.test(baseSha)) {
        fail('PROJECT_REPOSITORY_FACTS_READ_FAILED', 'GitHub returned incomplete pull request revision coordinates', { repository, pull_request:number });
      }
      const checksBody = await read(apiClient, `${repoPath}/commits/${headSha}/check-runs`, { per_page:100 });
      const checkRuns = Array.isArray(checksBody?.check_runs) ? checksBody.check_runs : null;
      const totalCount = Number(checksBody?.total_count);
      if (!checkRuns || !Number.isInteger(totalCount) || totalCount < 0) {
        fail('PROJECT_REPOSITORY_FACTS_READ_FAILED', 'GitHub returned invalid check-run evidence', { repository, pull_request:number });
      }
      if (totalCount > checkRuns.length) {
        fail('PROJECT_REPOSITORY_FACTS_INCOMPLETE', 'Check-run evidence may be truncated', { repository, pull_request:number, total_count:totalCount, observed:checkRuns.length });
      }
      pullRequests.push({
        number,
        state:String(pull.state || '').trim(),
        draft:Boolean(pull.draft),
        mergeable:pull.mergeable === null || pull.mergeable === undefined ? null : Boolean(pull.mergeable),
        head_sha:headSha,
        base_sha:baseSha,
        checks:checkRuns.map((check)=>({
          name:String(check?.name || '').trim(),
          status:String(check?.status || '').trim(),
          conclusion:check?.conclusion === null || check?.conclusion === undefined ? null : String(check.conclusion).trim(),
        })),
      });
    }

    const facts = normalizeProjectRepositoryFacts({
      schema:'project-repository-facts-v1',
      repository,
      revision,
      default_branch:defaultBranch,
      pull_requests:pullRequests,
    });

    return Object.freeze({
      schema:'project-authority-facts-v1',
      repository,
      revision,
      facts,
    });
  };
}
