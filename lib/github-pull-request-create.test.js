import { createGithubPullRequest, createGithubPullRequestWithGitHubApp, normalizeGithubPullRequestCreateRequest } from 'lib/github-pull-request-create.js';

const BASE = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';
const request = { repo: 'owner/repo', base: 'main', head: 'feature/test', expected_base: BASE, expected_head: HEAD, title: 'Test PR', body: 'fixture', draft: true };

function response(status, body, headers = {}) { return { status, body, headers }; }
function refBody(sha) { return { object: { type: 'commit', sha } }; }
function pull(number = 7, extra = {}) { return { number, state: 'open', draft: true, html_url: `https://github.com/owner/repo/pull/${number}`, user: { login: 'overcenter-app[bot]' }, head: { ref: 'feature/test', sha: HEAD }, base: { ref: 'main', sha: BASE }, ...extra }; }

export async function runGithubPullRequestCreateRegressionTests() {
  const results = [];
  const test = async (name, fn) => { try { await fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); } };
  const check = (condition, message) => { if (!condition) throw new Error(message); };

  await test('request validation is strict and exact-coordinate scoped', async () => {
    const normalized = normalizeGithubPullRequestCreateRequest(request);
    check(normalized.ok === true, `valid request rejected: ${JSON.stringify(normalized)}`);
    check(normalizeGithubPullRequestCreateRequest({ ...request, expected_head: 'abc' }).ok === false, 'short head SHA accepted');
    check(normalizeGithubPullRequestCreateRequest({ ...request, surprise: true }).ok === false, 'unknown field accepted');
  });

  await test('existing exact pull request is idempotent and does not create', async () => {
    const calls = [];
    const apiClient = { call: async (_name, opts) => {
      if (opts.path === '/repos/owner/repo') return response(200, { private: false, visibility: 'public' });
      calls.push(`${opts.method || 'GET'} ${opts.path}`);
      if (opts.path.includes('/git/ref/heads/main')) return response(200, refBody(BASE));
      if (opts.path.includes('/git/ref/heads/feature%2Ftest')) return response(200, refBody(HEAD));
      if (opts.path.endsWith('/pulls')) return response(200, [pull()]);
      throw new Error(`unexpected ${opts.method || 'GET'} ${opts.path}`);
    }, graphql: async () => response(200, { data: { repository: { pullRequest: { viewerCanUpdate: true, viewerDidAuthor: true } } } }) };
    const result = await createGithubPullRequest(request, { apiClient });
    check(result.ok === true && result.outcome === 'already_exists', `unexpected ${JSON.stringify(result)}`);
    check(!calls.some((entry) => entry.startsWith('POST ')), 'idempotent path attempted create');
  });

  await test('exact coordinates create a draft and record actor continuity', async () => {
    let listCount = 0;
    const apiClient = { call: async (_name, opts) => {
      if (opts.path === '/repos/owner/repo') return response(200, { private: false, visibility: 'public' });
      if (opts.path.includes('/git/ref/heads/main')) return response(200, refBody(BASE));
      if (opts.path.includes('/git/ref/heads/feature%2Ftest')) return response(200, refBody(HEAD));
      if (opts.path.endsWith('/pulls') && (opts.method || 'GET') === 'GET') { listCount += 1; return response(200, listCount === 1 ? [] : [pull()]); }
      if (opts.path.endsWith('/pulls') && opts.method === 'POST') return response(201, pull());
      throw new Error(`unexpected ${opts.method || 'GET'} ${opts.path}`);
    }, graphql: async () => response(200, { data: { repository: { pullRequest: { viewerCanUpdate: true, viewerDidAuthor: true } } } }) };
    const result = await createGithubPullRequest(request, { apiClient });
    check(result.ok === true && result.outcome === 'created' && result.draft === true, `unexpected ${JSON.stringify(result)}`);
    check(result.author_login === 'overcenter-app[bot]', 'author evidence missing');
    check(result.actor_continuity?.viewer_did_author === true && result.actor_continuity?.viewer_can_update === true, 'actor continuity missing');
  });

  await test('public repository metadata is rejected before any branch or pull-request mutation', async () => { const calls=[]; const workId=['LJH','-391'].join(''); const apiClient={call:async(_name,opts)=>{calls.push(`${opts.method||'GET'} ${opts.path}`);if(opts.path==='/repos/owner/repo')return response(200,{private:false,visibility:'public'});throw new Error('metadata rejection must precede branch reads and mutation');}}; const result=await createGithubPullRequest({...request,body:`internal work ${workId}`},{apiClient}); check(result.ok===false&&result.error==='PUBLIC_METADATA_POLICY_VIOLATION'&&result.may_have_mutated===false,`unexpected ${JSON.stringify(result)}`); check(calls.length===1,`unexpected calls ${JSON.stringify(calls)}`); });
  await test('private target repositories do not apply the public metadata policy', async () => { const projectId=['proj_','abcdefghijkl'].join(''); const apiClient={call:async(_name,opts)=>{if(opts.path==='/repos/owner/repo')return response(200,{private:true,visibility:'private'});if(opts.path.includes('/git/ref/heads/main'))return response(200,refBody(BASE));if(opts.path.includes('/git/ref/heads/feature%2Ftest'))return response(200,refBody(HEAD));if(opts.path.endsWith('/pulls'))return response(200,[pull()]);throw new Error(`unexpected ${opts.method||'GET'} ${opts.path}`);},graphql:async()=>response(200,{data:{repository:{pullRequest:{viewerCanUpdate:true,viewerDidAuthor:true}}}})}; const result=await createGithubPullRequest({...request,body:`deployment ${projectId}`},{apiClient}); check(result.ok===true&&result.outcome==='already_exists',`private target rejected: ${JSON.stringify(result)}`); });
  await test('non-public owner repository coordinates are rejected without returning the coordinate', async () => { const apiClient={call:async(_name,opts)=>{if(opts.path==='/repos/owner/repo')return response(200,{private:false,visibility:'public'});if(opts.path==='/repos/owner/private-example')return response(404,{message:'Not Found'});throw new Error('metadata rejection must precede branch reads and mutation');}}; const result=await createGithubPullRequest({...request,body:'See owner/private-example'},{apiClient}); check(result.ok===false&&result.error==='PUBLIC_METADATA_POLICY_VIOLATION',`unexpected ${JSON.stringify(result)}`); check(!JSON.stringify(result).includes('private-example'),'policy failure leaked coordinate'); });

  await test('stale base or head is refused before mutation', async () => {
    const apiClient = { call: async (_name, opts) => {
      if (opts.path === '/repos/owner/repo') return response(200, { private: false, visibility: 'public' });
      if (opts.path.includes('/git/ref/heads/main')) return response(200, refBody('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
      if (opts.path.includes('/git/ref/heads/feature%2Ftest')) return response(200, refBody(HEAD));
      throw new Error('mutation should not run');
    } };
    const result = await createGithubPullRequest(request, { apiClient });
    check(result.ok === false && result.error === 'BASE_MISMATCH' && result.may_have_mutated === false, `unexpected ${JSON.stringify(result)}`);
  });

  await test('lost create acknowledgement reconciles to the exact created pull request', async () => {
    let listCount = 0;
    const apiClient = { call: async (_name, opts) => {
      if (opts.path === '/repos/owner/repo') return response(200, { private: false, visibility: 'public' });
      if (opts.path.includes('/git/ref/heads/main')) return response(200, refBody(BASE));
      if (opts.path.includes('/git/ref/heads/feature%2Ftest')) return response(200, refBody(HEAD));
      if (opts.path.endsWith('/pulls') && (opts.method || 'GET') === 'GET') { listCount += 1; return response(200, listCount === 1 ? [] : [pull(8)]); }
      if (opts.path.endsWith('/pulls') && opts.method === 'POST') throw new Error('lost response');
      throw new Error(`unexpected ${opts.method || 'GET'} ${opts.path}`);
    }, graphql: async () => response(200, { data: { repository: { pullRequest: { viewerCanUpdate: true, viewerDidAuthor: true } } } }) };
    const result = await createGithubPullRequest(request, { apiClient });
    check(result.ok === true && result.outcome === 'created' && result.reconciled_after_indeterminate === true, `unexpected ${JSON.stringify(result)}`);
  });

  await test('unresolved create ambiguity stays indeterminate without retry', async () => {
    const apiClient = { call: async (_name, opts) => {
      if (opts.path === '/repos/owner/repo') return response(200, { private: false, visibility: 'public' });
      if (opts.path.includes('/git/ref/heads/main')) return response(200, refBody(BASE));
      if (opts.path.includes('/git/ref/heads/feature%2Ftest')) return response(200, refBody(HEAD));
      if (opts.path.endsWith('/pulls') && (opts.method || 'GET') === 'GET') return response(200, []);
      if (opts.path.endsWith('/pulls') && opts.method === 'POST') throw new Error('lost response');
      throw new Error(`unexpected ${opts.method || 'GET'} ${opts.path}`);
    } };
    const result = await createGithubPullRequest(request, { apiClient });
    check(result.ok === false && result.error === 'GITHUB_PULL_REQUEST_CREATE_INDETERMINATE' && result.may_have_mutated === true, `unexpected ${JSON.stringify(result)}`);
  });

  await test('GitHub App wrapper preserves strict public input and uses only the command-owned create profile', async () => {
    let profile = null;
    const apiClient = { call: async (_name, opts) => {
      if (opts.path === '/repos/owner/repo') return response(200, { private: false, visibility: 'public' });
      if (opts.path.includes('/git/ref/heads/main')) return response(200, refBody(BASE));
      if (opts.path.includes('/git/ref/heads/feature%2Ftest')) return response(200, refBody(HEAD));
      if (opts.path.endsWith('/pulls')) return response(200, [pull()]);
      throw new Error(`unexpected ${opts.method || 'GET'} ${opts.path}`);
    }, graphql: async () => response(200, { data: { repository: { pullRequest: { viewerCanUpdate: true, viewerDidAuthor: true } } } }) };
    const result = await createGithubPullRequestWithGitHubApp(request, { withGitHubAppApiClient: async (_repo, callback, options) => { profile = options.permissionProfile; return callback(apiClient); } });
    check(profile === 'pull_request_create', `wrong profile ${profile}`);
    check(result.ok === true && result.outcome === 'already_exists', `wrapper corrupted normalized input: ${JSON.stringify(result)}`);
  });

  return { ok: results.every((r) => r.ok), passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}