import { api } from 'hatchable';

const TERMINAL_STATE_TYPES = new Set(['completed', 'canceled']);

function makeError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function normalizeIssueRef(issue) {
  const value = String(issue || '').trim();
  if (!value || value.length > 128) {
    throw makeError(
      'LINEAR_ARCHIVE_INVALID_ISSUE',
      'issue must be a Linear issue identifier or UUID between 1 and 128 characters',
    );
  }
  return value;
}

async function linearGraphQL(apiBinding, query, variables, { mayHaveMutated = false } = {}) {
  let response;
  try {
    response = await apiBinding.call('linear', {
      method: 'POST',
      path: '',
      headers: { 'Content-Type': 'application/json' },
      body: { query, variables },
    });
  } catch (error) {
    const message = String(error?.message || 'Linear transport failed');
    const setupRequired = String(error?.code || '') === 'SetupRequired'
      || Number(error?.status || error?.statusCode || error?.httpStatus) === 412
      || (message.includes('412') && message.includes('API "linear" is not connected'));
    if (setupRequired && !mayHaveMutated) {
      throw makeError('LINEAR_SETUP_REQUIRED', 'Connect the Linear API in the Hatchable project Setup page for Busbar.');
    }
    throw makeError(
      mayHaveMutated ? 'LINEAR_ARCHIVE_INDETERMINATE' : 'LINEAR_ARCHIVE_UPSTREAM_HTTP',
      message,
      { may_have_mutated: mayHaveMutated, upstream_code: error?.code || null },
    );
  }

  if (!response || response.status < 200 || response.status >= 300) {
    throw makeError(
      mayHaveMutated ? 'LINEAR_ARCHIVE_INDETERMINATE' : 'LINEAR_ARCHIVE_UPSTREAM_HTTP',
      `Linear API returned HTTP ${response?.status ?? 'unknown'}`,
      { status: response?.status ?? null, may_have_mutated: mayHaveMutated },
    );
  }

  let body = response.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      throw makeError(
        mayHaveMutated ? 'LINEAR_ARCHIVE_INDETERMINATE' : 'LINEAR_ARCHIVE_UPSTREAM_INVALID',
        'Linear API returned a non-JSON response',
        { may_have_mutated: mayHaveMutated },
      );
    }
  }

  if (Array.isArray(body?.errors) && body.errors.length) {
    throw makeError(
      mayHaveMutated ? 'LINEAR_ARCHIVE_INDETERMINATE' : 'LINEAR_ARCHIVE_UPSTREAM_GRAPHQL',
      String(body.errors[0]?.message || 'Linear GraphQL request failed'),
      {
        may_have_mutated: mayHaveMutated,
        errors: body.errors.map(error => ({
          message: String(error?.message || 'Linear GraphQL error'),
          path: error?.path || null,
          code: error?.extensions?.code || null,
        })),
      },
    );
  }

  return body?.data || null;
}

export function createLinearArchiveService({ apiBinding = api } = {}) {
  async function inspect(issue) {
    const issueRef = normalizeIssueRef(issue);
    const data = await linearGraphQL(
      apiBinding,
      `query LinearArchiveCandidate($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          archivedAt
          state {
            name
            type
          }
        }
      }`,
      { id: issueRef },
    );

    const candidate = data?.issue;
    if (!candidate) {
      throw makeError('LINEAR_ARCHIVE_NOT_FOUND', `Linear issue ${issueRef} was not found`);
    }

    const stateType = String(candidate.state?.type || '').toLowerCase();
    const alreadyArchived = Boolean(candidate.archivedAt);
    const terminal = TERMINAL_STATE_TYPES.has(stateType);

    return {
      id: candidate.id,
      identifier: candidate.identifier,
      title: candidate.title,
      state: {
        name: candidate.state?.name || null,
        type: stateType || null,
      },
      archivedAt: candidate.archivedAt || null,
      alreadyArchived,
      terminal,
      eligible: alreadyArchived || terminal,
    };
  }

  async function archive({ issue, dryRun = false } = {}) {
    const candidate = await inspect(issue);

    if (candidate.alreadyArchived) {
      return {
        ok: true,
        action: 'archive_linear_issue',
        changed: false,
        alreadyArchived: true,
        candidate,
      };
    }

    if (!candidate.terminal) {
      throw makeError(
        'LINEAR_ARCHIVE_NOT_TERMINAL',
        `${candidate.identifier} is ${candidate.state.name || candidate.state.type || 'non-terminal'}; only completed or canceled issues may be archived`,
        { candidate },
      );
    }

    if (dryRun) {
      return {
        ok: true,
        action: 'archive_linear_issue',
        changed: false,
        dryRun: true,
        eligible: true,
        candidate,
      };
    }

    const data = await linearGraphQL(
      apiBinding,
      `mutation ArchiveLinearIssue($id: String!) {
        issueArchive(id: $id) {
          success
        }
      }`,
      { id: candidate.id },
      { mayHaveMutated: true },
    );

    if (data?.issueArchive?.success !== true) {
      throw makeError(
        'LINEAR_ARCHIVE_NOT_CONFIRMED',
        `Linear did not confirm archival of ${candidate.identifier}`,
        { candidate },
      );
    }

    return {
      ok: true,
      action: 'archive_linear_issue',
      changed: true,
      archived: true,
      candidate,
    };
  }

  return { inspect, archive };
}

export async function inspectLinearArchiveCandidate(issue, options = {}) {
  return createLinearArchiveService(options).inspect(issue);
}

export async function archiveLinearIssue(input, options = {}) {
  return createLinearArchiveService(options).archive(input);
}