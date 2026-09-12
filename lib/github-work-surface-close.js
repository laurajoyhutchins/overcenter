import { withGitHubAppApiClient } from './github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from './github-transport.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-fA-F]{40}$/;

const PR_QUERY = `query ClosePullRequestPreflight($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){id pullRequest(number:$number){id number state merged headRefOid url}}}`;
const ISSUE_QUERY = `query CloseIssuePreflight($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){id issue(number:$number){id number state url}}}`;
const CLOSE_PR = `mutation ClosePullRequest($input:ClosePullRequestInput!){closePullRequest(input:$input){clientMutationId pullRequest{id number state merged headRefOid url}}}`;
const CLOSE_ISSUE = `mutation CloseIssue($input:CloseIssueInput!){closeIssue(input:$input){clientMutationId issue{id number state url}}}`;

function fail(error, message, details = {}) { return { ok:false, error, message, ...details }; }
function errors(response) { return Array.isArray(response?.body?.errors) ? response.body.errors : []; }
function summaries(response) { return errors(response).map((e) => ({ message:String(e?.message || 'GitHub GraphQL error'), ...(e?.type ? { type:String(e.type) } : {}) })); }

export function normalizeGithubWorkSurfaceCloseRequest(kind, input) {
  if (!['pull_request','issue'].includes(kind)) return fail('INVALID_KIND','unsupported GitHub work-surface kind');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_REQUEST','request must be an object');
  const allowed = new Set(kind === 'pull_request' ? ['repo','pull_request','expected_head','artifact_ref','run_id'] : ['repo','issue','artifact_ref','run_id']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) return fail('INVALID_REQUEST','request contains unknown fields',{ unknown, may_have_mutated:false });
  const repo = String(input.repo || '').trim();
  if (!REPO.test(repo)) return fail('INVALID_REPOSITORY','repo must be owner/repo',{ may_have_mutated:false });
  const number = Number(input[kind]);
  if (!Number.isInteger(number) || number < 1) return fail('INVALID_PROVIDER_OBJECT',`${kind} must be a positive integer`,{ may_have_mutated:false });
  const artifactRef = String(input.artifact_ref || '').trim();
  if (!artifactRef || artifactRef.length > 512) return fail('INVALID_ARTIFACT_REF','artifact_ref must bind the semantic artifact identity',{ may_have_mutated:false });
  if (kind === 'pull_request') {
    const expectedHead = String(input.expected_head || '').trim().toLowerCase();
    if (!SHA40.test(expectedHead)) return fail('INVALID_SHA','expected_head must be an exact 40-character Git SHA',{ may_have_mutated:false });
    return { ok:true, kind, repo, number, expected_head:expectedHead, artifact_ref:artifactRef };
  }
  return { ok:true, kind, repo, number, artifact_ref:artifactRef };
}

async function readSurface(apiClient, normalized, options = {}, phase = 'preflight') {
  const [owner,name] = normalized.repo.split('/');
  let retried;
  try {
    retried = await boundedSafeRead(() => apiClient.graphql(normalized.kind === 'pull_request' ? PR_QUERY : ISSUE_QUERY, { owner,name,number:normalized.number }), { sleep:options.sleep, random:options.random, maxAttempts:options.maxAttempts || 3 });
  } catch (error) {
    return fail('GITHUB_UPSTREAM_ERROR',String(error?.message || error),{ phase, may_have_mutated:false });
  }
  const response = retried.response;
  if (!response || Number(response.status) < 200 || Number(response.status) >= 300 || errors(response).length) {
    const status = Number(response?.status || 0);
    const detail = summaries(response);
    const notFound = status === 404 || detail.some((e) => /not found|could not resolve/i.test(e.message));
    return fail(notFound ? 'GITHUB_NOT_FOUND' : 'GITHUB_UPSTREAM_ERROR', detail[0]?.message || `GitHub returned HTTP ${status || 'unknown'}`, { phase, may_have_mutated:false, ...githubTransportEvidence(response,{ phase,path:'/graphql',attempts:retried.attempts,mayHaveMutated:false }) });
  }
  const object = normalized.kind === 'pull_request' ? response.body?.data?.repository?.pullRequest : response.body?.data?.repository?.issue;
  if (!object?.id) return fail('GITHUB_NOT_FOUND','The exact GitHub work surface was not found.',{ phase, may_have_mutated:false });
  return { ok:true, id:String(object.id), number:Number(object.number), state:String(object.state || '').toUpperCase(), url:object.url ? String(object.url) : null, ...(normalized.kind === 'pull_request' ? { merged:Boolean(object.merged), head_sha:object.headRefOid ? String(object.headRefOid).toLowerCase() : null } : {}) };
}

function success(normalized, observed, outcome, extra = {}) {
  return { ok:true, outcome, repo:normalized.repo, artifact_ref:normalized.artifact_ref, [normalized.kind]:normalized.number, state:observed.state, url:observed.url, ...(normalized.expected_head ? { expected_head:normalized.expected_head } : {}), ...extra };
}

async function reconcile(apiClient, normalized, options, mutationEvidence) {
  const after = await readSurface(apiClient, normalized, options, 'reconcile_after_indeterminate');
  if (after.ok && normalized.kind === 'pull_request' && after.head_sha !== normalized.expected_head) return fail('GITHUB_WORK_SURFACE_CLOSE_INDETERMINATE','Closure may have completed across pull-request head drift.',{ may_have_mutated:true, expected_head:normalized.expected_head, actual_head:after.head_sha, mutation_evidence:mutationEvidence });
  if (after.ok && (after.state === 'CLOSED' || (normalized.kind === 'pull_request' && after.merged))) return success(normalized, after, 'closed',{ mutation_attempted:true, reconciled_after_indeterminate:true, mutation_evidence:mutationEvidence });
  return fail('GITHUB_WORK_SURFACE_CLOSE_INDETERMINATE','Closure mutation lost transport certainty and authoritative readback does not prove the intended final state.',{ may_have_mutated:true, mutation_evidence:mutationEvidence, reconciliation:after });
}

export async function closeGithubWorkSurface(kind, input, options = {}) {
  const normalized = normalizeGithubWorkSurfaceCloseRequest(kind,input);
  if (!normalized.ok) return normalized;
  const apiClient = options.apiClient;
  if (!apiClient || typeof apiClient.graphql !== 'function') return fail('GITHUB_TRANSPORT_UNAVAILABLE','A GitHub GraphQL transport is required.',{ may_have_mutated:false });
  const before = await readSurface(apiClient,normalized,options,'preflight');
  if (!before.ok) return before;
  if (normalized.kind === 'pull_request' && before.head_sha !== normalized.expected_head) return fail('HEAD_MISMATCH','The pull request head does not match expected_head.',{ expected_head:normalized.expected_head, actual_head:before.head_sha, may_have_mutated:false });
  if (before.state === 'CLOSED' || (normalized.kind === 'pull_request' && before.merged)) return success(normalized,before,'already_closed',{ mutation_attempted:false });
  if (before.state !== 'OPEN') return fail('GITHUB_WORK_SURFACE_STATE_INVALID','Only an open GitHub work surface can be closed.',{ state:before.state, may_have_mutated:false });
  const mutation = normalized.kind === 'pull_request' ? CLOSE_PR : CLOSE_ISSUE;
  const variable = normalized.kind === 'pull_request' ? 'pullRequestId' : 'issueId';
  let response;
  try {
    response = await apiClient.graphql(mutation,{ input:{ [variable]:before.id, clientMutationId:`close:${normalized.kind}:${normalized.number}:${normalized.artifact_ref}` } });
  } catch (error) {
    return reconcile(apiClient,normalized,options,{ phase:'close', transport_error:String(error?.message || error), may_have_mutated:true });
  }
  const status = Number(response?.status || 0);
  if (!response || status < 200 || status >= 300 || errors(response).length) {
    const mutationData = normalized.kind === 'pull_request' ? response?.body?.data?.closePullRequest?.pullRequest : response?.body?.data?.closeIssue?.issue;
    const mayHaveMutated = Boolean(mutationData?.id) || (status >= 500 && status <= 599);
    const evidence = { phase:'close', upstream_status:status || null, graphql_errors:summaries(response), ...githubTransportEvidence(response,{ phase:'close',path:'/graphql',attempts:1,mayHaveMutated }) };
    if (mayHaveMutated) return reconcile(apiClient,normalized,options,evidence);
    return fail(status === 401 || status === 403 ? 'GITHUB_PERMISSION_DENIED' : 'GITHUB_UPSTREAM_ERROR', summaries(response)[0]?.message || `GitHub returned HTTP ${status || 'unknown'}`,{ ...evidence, may_have_mutated:false });
  }
  const after = await readSurface(apiClient,normalized,options,'post_mutation_verify');
  if (!after.ok) return fail('GITHUB_WORK_SURFACE_CLOSE_INDETERMINATE','GitHub acknowledged closure but authoritative verification failed.',{ may_have_mutated:true, verification_error:after });
  if (normalized.kind === 'pull_request' && after.head_sha !== normalized.expected_head) return fail('GITHUB_WORK_SURFACE_CLOSE_INDETERMINATE','Closure completed across pull-request head drift.',{ may_have_mutated:true, expected_head:normalized.expected_head, actual_head:after.head_sha });
  if (after.state !== 'CLOSED' && !(normalized.kind === 'pull_request' && after.merged)) return fail('GITHUB_WORK_SURFACE_CLOSE_INDETERMINATE','GitHub acknowledged closure but fresh readback does not prove closed state.',{ may_have_mutated:true, observed_state:after.state });
  return success(normalized,after,'closed',{ mutation_attempted:true, reconciled_after_indeterminate:false });
}

function mapAuthError(error) {
  const status = Number(error?.status || 0);
  if ([401,403,422].includes(status)) return fail('GITHUB_APP_PERMISSION_DENIED',String(error?.message || error),{ upstream_status:status, may_have_mutated:false });
  if (status === 404) return fail('GITHUB_APP_INSTALLATION_NOT_FOUND','The GitHub App is not installed for this repository.',{ upstream_status:404, may_have_mutated:false });
  return fail(error?.code || 'GITHUB_APP_AUTH_ERROR',String(error?.message || error),{ may_have_mutated:false });
}

export async function closeGithubWorkSurfaceWithGitHubApp(kind,input,options = {}) {
  const normalized = normalizeGithubWorkSurfaceCloseRequest(kind,input);
  if (!normalized.ok) return normalized;
  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  const permissionProfile = kind === 'pull_request' ? 'pull_request_close' : 'issue_close';
  try { return await withApp(normalized.repo,(apiClient) => closeGithubWorkSurface(kind,input,{ ...options,apiClient }),{ permissionProfile }); }
  catch (error) { return mapAuthError(error); }
}

export const closeGithubPullRequestWithGitHubApp = (input,options = {}) => closeGithubWorkSurfaceWithGitHubApp('pull_request',input,options);
export const closeGithubIssueWithGitHubApp = (input,options = {}) => closeGithubWorkSurfaceWithGitHubApp('issue',input,options);
