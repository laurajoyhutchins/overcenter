const SHA40 = /^[0-9a-f]{40}$/;

function fail(code, message, details = null) {
  throw Object.assign(new Error(message), { code, may_have_mutated:false, details });
}

export async function verifyProductionMaterializationHead(input, deps = {}) {
  const repo = typeof input?.repo === 'string' ? input.repo.trim() : '';
  const branch = typeof input?.production_branch === 'string' ? input.production_branch.trim() : '';
  const revision = typeof input?.exact_revision === 'string' ? input.exact_revision.trim().toLowerCase() : '';
  const token = typeof input?.token === 'string' ? input.token.trim() : '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail('PRODUCTION_MATERIALIZATION_REPO_INVALID', 'repo must be owner/repository');
  if (!branch) fail('PRODUCTION_MATERIALIZATION_BRANCH_INVALID', 'production branch is required');
  if (!SHA40.test(revision)) fail('PRODUCTION_MATERIALIZATION_REVISION_INVALID', 'exact revision must be a 40-character lowercase Git SHA');
  if (!token) fail('PRODUCTION_MATERIALIZATION_GITHUB_TOKEN_MISSING', 'GitHub token is required');
  const fetchImpl = deps.fetch || fetch;
  const [owner, name] = repo.split('/');
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetchImpl(url, {
    headers: {
      Accept:'application/vnd.github+json',
      Authorization:`Bearer ${token}`,
      'X-GitHub-Api-Version':'2026-03-10',
      'User-Agent':'Overcenter-production-materialization-fence',
    },
  });
  if (!response.ok) {
    fail('PRODUCTION_MATERIALIZATION_HEAD_OBSERVATION_FAILED', `GitHub production head observation failed with status ${response.status}`, { status:response.status });
  }
  const body = await response.json();
  const observed = typeof body?.object?.sha === 'string' ? body.object.sha.trim().toLowerCase() : '';
  if (!SHA40.test(observed)) fail('PRODUCTION_MATERIALIZATION_HEAD_INVALID', 'GitHub returned an invalid production head');
  if (observed !== revision) {
    fail('PRODUCTION_MATERIALIZATION_HEAD_DRIFT', 'production branch moved before materialization', { expected_revision:revision, observed_revision:observed });
  }
  return { ok:true, repo, production_branch:branch, exact_revision:revision, observed_revision:observed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await verifyProductionMaterializationHead({
    repo:process.env.GITHUB_REPOSITORY,
    production_branch:process.env.PRODUCTION_BRANCH,
    exact_revision:process.env.EXACT_REVISION,
    token:process.env.GITHUB_TOKEN,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}