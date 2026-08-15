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

async function linearGraphQL(query, variables) {
  const response = await api.call('linear', {
    method: 'POST',
    path: '',
    headers: { 'Content-Type': 'application/json' },
    body: { query, variables },
  });

  if (!response || response.status < 200 || response.status >= 300) {
    throw makeError(
      'LINEAR_ARCHIVE_UPSTREAM_HTTP',
      `Linear API returned HTTP ${response?.status ?? 'unknown'}`,
      { status: response?.status ?? null },
    );
  }

  let body = response.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      throw makeError('LINEAR_ARCHIVE_UPSTREAM_INVALID', 'Linear API returned a non-JSON response');
    }
  }

  if (Array.isArray(body?.errors) && body.errors.length) {
    throw makeError(
      'LINEAR_ARCHIVE_UPSTREAM_GRAPHQL',
      String(body.errors[0]?.message || 'Linear GraphQL request failed'),
      {
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

export async function inspectLinearArchiveCandidate(issue) {
  const issueRef = normalizeIssueRef(issue);
  const data = await linearGraphQL(
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

export async function archiveLinearIssue({ issue, dryRun = false } = {}) {
  const candidate = await inspectLinearArchiveCandidate(issue);

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
    `mutation ArchiveLinearIssue($id: String!) {
      issueArchive(id: $id) {
        success
      }
    }`,
    { id: candidate.id },
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