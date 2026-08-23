import { api, db } from 'hatchable';

function identityError(code, message, details = null, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

export function normalizeGitHubRepositoryId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw identityError('INVALID_GITHUB_REPOSITORY_ID', 'GitHub repository id must be a positive integer', { github_repository_id: value }, 422);
  return id;
}

export function rewriteRepositoryCoordinate(description, fromRepository, toRepository) {
  const text = String(description || '');
  const from = String(fromRepository || '').trim();
  const to = String(toRepository || '').trim();
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const direct = new RegExp(`(^\\s*Repository\\s*:\\s*\`?)${escaped}(\`?[.,;:]?\\s*$)`, 'mi');
  if (direct.test(text)) return text.replace(direct, `$1${to}$2`);
  const heading = new RegExp(`(^\\s*##\\s+Repository\\s*$[\\s\\r\\n]*\`?)${escaped}(\`?)`, 'mi');
  if (heading.test(text)) return text.replace(heading, `$1${to}$2`);
  return text;
}

async function linearGraphQL(apiBinding, query, variables, { mayHaveMutated = false } = {}) {
  let response;
  try {
    response = await apiBinding.call('linear', { method:'POST', path:'', headers:{ 'Content-Type':'application/json' }, body:{ query, variables } });
  } catch (error) {
    throw identityError(mayHaveMutated ? 'REPOSITORY_RENAME_LINEAR_INDETERMINATE' : 'REPOSITORY_RENAME_LINEAR_UPSTREAM', String(error?.message || 'Linear transport failed'), { may_have_mutated: mayHaveMutated }, mayHaveMutated ? 409 : 502);
  }
  if (!response || response.status < 200 || response.status >= 300) throw identityError(mayHaveMutated ? 'REPOSITORY_RENAME_LINEAR_INDETERMINATE' : 'REPOSITORY_RENAME_LINEAR_UPSTREAM', `Linear API returned HTTP ${response?.status ?? 'unknown'}`, { may_have_mutated: mayHaveMutated, upstream_status: response?.status || null }, mayHaveMutated ? 409 : 502);
  let body = response.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { throw identityError('REPOSITORY_RENAME_LINEAR_INVALID', 'Linear returned non-JSON', null, 502); } }
  if (Array.isArray(body?.errors) && body.errors.length) throw identityError(mayHaveMutated ? 'REPOSITORY_RENAME_LINEAR_INDETERMINATE' : 'REPOSITORY_RENAME_LINEAR_GRAPHQL', String(body.errors[0]?.message || 'Linear GraphQL failed'), { may_have_mutated: mayHaveMutated }, mayHaveMutated ? 409 : 502);
  return body?.data || null;
}

export function createLinearRepositoryCoordinateProjection({ apiBinding = api } = {}) {
  async function inspect(id) {
    const data = await linearGraphQL(apiBinding, 'query RepositoryRenameIssue($id:String!){issue(id:$id){id identifier description}}', { id:String(id) });
    if (!data?.issue) throw identityError('REPOSITORY_RENAME_LINEAR_NOT_FOUND', 'Linear work projection was not found', { issue:id }, 404);
    return data.issue;
  }

  async function rebind(workIdentities, fromRepository, toRepository) {
    const changed = [];
    for (const identity of workIdentities || []) {
      if (!identity?.linear_issue_id) continue;
      const issue = await inspect(identity.linear_issue_id);
      const nextDescription = rewriteRepositoryCoordinate(issue.description, fromRepository, toRepository);
      if (nextDescription === issue.description) continue;
      try {
        const data = await linearGraphQL(apiBinding, 'mutation RepositoryRenameUpdate($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success issue{id identifier description}}}', { id:issue.id, input:{ description:nextDescription } }, { mayHaveMutated:true });
        if (data?.issueUpdate?.success !== true || data?.issueUpdate?.issue?.description !== nextDescription) throw identityError('REPOSITORY_RENAME_LINEAR_NOT_CONFIRMED', 'Linear did not confirm repository coordinate update', { identifier:issue.identifier }, 409);
      } catch (error) {
        if (error?.code !== 'REPOSITORY_RENAME_LINEAR_INDETERMINATE') throw error;
        const observed = await inspect(issue.id);
        if (observed.description !== nextDescription) throw error;
      }
      changed.push(issue.identifier || identity.linear_identifier || issue.id);
    }
    return changed;
  }

  return { rebind, inspect };
}

export function createPostgresRepositoryIdentityStore(dbBinding = db) {
  return {
    async getByGitHubRepositoryId(value) {
      const id = normalizeGitHubRepositoryId(value);
      const result = await dbBinding.query('SELECT * FROM portfolio_repository_disposition WHERE github_repository_id=$1 LIMIT 1', [id]);
      return result.rows?.[0] || null;
    },
    async listUnbound() {
      const result = await dbBinding.query('SELECT * FROM portfolio_repository_disposition WHERE github_repository_id IS NULL ORDER BY lower(repository)');
      return result.rows || [];
    },
    async bindGitHubRepositoryId(repository, value) {
      const id = normalizeGitHubRepositoryId(value);
      const result = await dbBinding.query('UPDATE portfolio_repository_disposition SET github_repository_id=$2, updated_at=now() WHERE lower(repository)=lower($1) AND github_repository_id IS NULL RETURNING *', [repository, id]);
      return result.rows?.[0] || null;
    },
    async listWorkIdentities(repository) {
      const result = await dbBinding.query('SELECT source_key, source_kind, source_repo, source_issue_number, linear_issue_id, linear_identifier FROM portfolio_work_identity WHERE lower(source_repo)=lower($1) ORDER BY source_issue_number NULLS LAST, linear_identifier', [repository]);
      return result.rows || [];
    },
    async rebindRepositoryIdentity({ github_repository_id, from_repository, to_repository, updated_at }) {
      const id = normalizeGitHubRepositoryId(github_repository_id);
      await dbBinding.transaction([
        { sql:'UPDATE portfolio_repository_disposition SET repository=$2, updated_at=$3 WHERE lower(repository)=lower($1) AND github_repository_id=$4', params:[from_repository, to_repository, updated_at, id] },
        { sql:"UPDATE portfolio_work_identity SET source_repo=$2, source_key=CASE WHEN source_kind='github_issue' AND source_issue_number IS NOT NULL THEN 'github:' || $2 || '#issue:' || source_issue_number::text ELSE source_key END, updated_at=$3 WHERE lower(source_repo)=lower($1)", params:[from_repository, to_repository, updated_at] },
      ]);
      const result = await dbBinding.query('SELECT * FROM portfolio_repository_disposition WHERE github_repository_id=$1 LIMIT 1', [id]);
      return result.rows?.[0] || null;
    },
  };
}