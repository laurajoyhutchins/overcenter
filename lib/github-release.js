import { canonicalJson, sha256Text } from './canonical-json.js';

const SHA = /^[0-9a-f]{40}$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG_EXPECTED = new Set(['absent', 'present_same_commit']);
const RELEASE_EXPECTED = new Set(['absent', 'present_matching']);

function fail(error, message, details = {}, mayHaveMutated = false) {
  return { ok: false, error, message, details, may_have_mutated: mayHaveMutated };
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function requiredString(value, field, max = 1024, preserve = false) {
  if (typeof value !== 'string') throw Object.assign(new Error(`${field} must be a string`), { code: 'INVALID_REQUEST' });
  const checked = preserve ? value : value.trim();
  if (!checked || checked.length > max) throw Object.assign(new Error(`${field} must be non-empty and at most ${max} characters`), { code: 'INVALID_REQUEST' });
  return checked;
}
function exactFields(body, allowed, label = 'request') {
  const unknown = Object.keys(body).filter(key => !allowed.has(key));
  if (unknown.length) throw Object.assign(new Error(`${label} contains unsupported fields`), { code: 'INVALID_REQUEST', details: { unsupported_fields: unknown.sort() } });
}
function validTagName(tag) {
  return !tag.startsWith('/') && !tag.endsWith('/') && !tag.endsWith('.') && !tag.endsWith('.lock') && !tag.startsWith('refs/') &&
    !tag.includes('..') && !tag.includes('@{') && !tag.includes('//') && !/[\x00-\x20\x7f~^:?*\[\\]/.test(tag);
}

export function normalizeGithubReleaseRequest(input) {
  const body = object(input);
  exactFields(body, new Set(['repo','target_sha','tag_name','name','body','draft','prerelease','expected_state','idempotency_key']));
  const repo = requiredString(body.repo, 'repo', 200);
  if (!REPO.test(repo)) throw Object.assign(new Error('repo must be in owner/name form'), { code: 'INVALID_REQUEST' });
  const target_sha = requiredString(body.target_sha, 'target_sha', 40).toLowerCase();
  if (!SHA.test(target_sha)) throw Object.assign(new Error('target_sha must be an exact 40-character Git commit SHA'), { code: 'INVALID_REQUEST' });
  const tag_name = requiredString(body.tag_name, 'tag_name', 255);
  if (!validTagName(tag_name)) throw Object.assign(new Error('tag_name is not a valid immutable Git ref name'), { code: 'INVALID_REQUEST' });
  const name = requiredString(body.name, 'name', 256, true);
  if (typeof body.body !== 'string' || body.body.length > 125000) throw Object.assign(new Error('body must be a string of at most 125000 characters'), { code: 'INVALID_REQUEST' });
  if (typeof body.draft !== 'boolean' || typeof body.prerelease !== 'boolean') throw Object.assign(new Error('draft and prerelease must be booleans'), { code: 'INVALID_REQUEST' });
  const expected = object(body.expected_state);
  exactFields(expected, new Set(['tag','release']), 'expected_state');
  if (!TAG_EXPECTED.has(expected.tag) || !RELEASE_EXPECTED.has(expected.release)) {
    throw Object.assign(new Error('expected_state must explicitly fence tag and release state'), { code: 'INVALID_REQUEST' });
  }
  const idempotency_key = requiredString(body.idempotency_key, 'idempotency_key', 200);
  return { repo, target_sha, tag_name, name, body: body.body, draft: body.draft, prerelease: body.prerelease, expected_state: { tag: expected.tag, release: expected.release }, idempotency_key };
}

function repoBase(repo) { const [owner, name] = repo.split('/'); return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`; }
async function api(apiClient, method, path, body) {
  try { return await apiClient.call('github', { method, path, ...(body === undefined ? {} : { body }) }); }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { github_method: method, github_path: path }); }
}
function good(response) { return Number(response?.status) >= 200 && Number(response?.status) < 300; }

async function resolveTagCommit(apiClient, base, refBody, depth = 0) {
  const obj = refBody?.object;
  if (!obj?.sha || !obj?.type) return null;
  if (obj.type === 'commit') return String(obj.sha).toLowerCase();
  if (obj.type !== 'tag' || depth >= 4) return null;
  const response = await api(apiClient, 'GET', `${base}/git/tags/${encodeURIComponent(obj.sha)}`);
  if (!good(response)) return null;
  return resolveTagCommit(apiClient, base, { object: response.body?.object }, depth + 1);
}

async function observe(apiClient, normalized) {
  const base = repoBase(normalized.repo);
  const repository = await api(apiClient, 'GET', base);
  if (repository.status === 404) return fail('GITHUB_NOT_FOUND', 'repository does not exist or is not accessible', { repo: normalized.repo }, false);
  if (repository.status === 401 || repository.status === 403) return fail('GITHUB_PERMISSION_DENIED', 'GitHub App cannot access the repository', { repo: normalized.repo, required_permissions: { contents: 'write' } }, false);
  if (!good(repository)) return fail('GITHUB_RELEASE_INDETERMINATE', 'repository observation failed', { repo: normalized.repo, upstream_status: repository.status }, false);

  const commit = await api(apiClient, 'GET', `${base}/commits/${normalized.target_sha}`);
  if (commit.status === 404) return fail('GITHUB_RELEASE_TARGET_NOT_FOUND', 'target commit does not exist', { repo: normalized.repo, target_sha: normalized.target_sha }, false);
  if (!good(commit)) return fail('GITHUB_RELEASE_INDETERMINATE', 'target commit observation failed', { repo: normalized.repo, target_sha: normalized.target_sha, upstream_status: commit.status }, false);
  const verifiedCommit = String(commit.body?.sha || '').toLowerCase();
  if (verifiedCommit !== normalized.target_sha) return fail('GITHUB_RELEASE_VERIFICATION_FAILED', 'GitHub did not return the exact requested commit', { requested_sha: normalized.target_sha, observed_sha: verifiedCommit || null }, false);

  const encodedTag = encodeURIComponent(normalized.tag_name);
  const tagResponse = await api(apiClient, 'GET', `${base}/git/ref/tags/${encodedTag}`);
  if (tagResponse.status !== 404 && !good(tagResponse)) return fail('GITHUB_RELEASE_INDETERMINATE', 'tag observation failed', { tag_name: normalized.tag_name, upstream_status: tagResponse.status }, false);
  const tag = good(tagResponse) ? tagResponse.body : null;
  const tagCommit = tag ? await resolveTagCommit(apiClient, base, tag) : null;

  const releaseResponse = await api(apiClient, 'GET', `${base}/releases/tags/${encodedTag}`);
  if (releaseResponse.status !== 404 && !good(releaseResponse)) return fail('GITHUB_RELEASE_INDETERMINATE', 'release observation failed', { tag_name: normalized.tag_name, upstream_status: releaseResponse.status }, false);
  return { ok: true, base, repository: repository.body, verified_commit_sha: verifiedCommit, tag, tag_commit_sha: tagCommit, release: good(releaseResponse) ? releaseResponse.body : null };
}

function releaseMatches(release, normalized) {
  return Boolean(release) && String(release.tag_name || '') === normalized.tag_name && String(release.name ?? '') === normalized.name &&
    String(release.body ?? '') === normalized.body && Boolean(release.draft) === normalized.draft && Boolean(release.prerelease) === normalized.prerelease;
}
function classify(obs, normalized) {
  if (!obs.tag && !obs.release) return 'absent';
  if (obs.tag && !obs.release) return obs.tag_commit_sha === normalized.target_sha ? 'tag_only_matching' : 'tag_conflict';
  if (!obs.tag && obs.release) return 'release_without_tag';
  if (obs.tag_commit_sha !== normalized.target_sha) return 'tag_conflict';
  return releaseMatches(obs.release, normalized) ? 'satisfied' : 'release_conflict';
}
function receipt(normalized, digest, obs, preState, outcome, created, replay) {
  return {
    ok: true,
    repo: normalized.repo,
    requested_commit_sha: normalized.target_sha,
    verified_commit_sha: obs.tag_commit_sha,
    tag_name: normalized.tag_name,
    tag_ref: obs.tag?.ref || `refs/tags/${normalized.tag_name}`,
    tag_ref_node_id: obs.tag?.node_id || null,
    release_id: Number(obs.release?.id) || null,
    release_url: obs.release?.html_url || null,
    release_name: obs.release?.name ?? normalized.name,
    draft: Boolean(obs.release?.draft),
    prerelease: Boolean(obs.release?.prerelease),
    release_created_at: obs.release?.created_at || null,
    release_published_at: obs.release?.published_at || null,
    pre_state: preState,
    post_state: 'satisfied',
    outcome,
    created,
    verified: true,
    verification_result: 'verified',
    idempotency_key: normalized.idempotency_key,
    request_sha256: digest,
    idempotent_replay: replay,
    may_have_mutated: false,
  };
}

export function createGithubReleaseReceiptStore(dbBinding) {
  return {
    async claim(normalized,digest){ const token=crypto.randomUUID(); const inserted=await dbBinding.query("INSERT INTO github_release_receipts (repo,idempotency_key,request_sha256,request_json,state,attempt_token,target_sha,tag_name) VALUES ($1,$2,$3,$4::jsonb,'processing',$5,$6,$7) ON CONFLICT (repo,idempotency_key) DO NOTHING RETURNING *",[normalized.repo,normalized.idempotency_key,digest,JSON.stringify(normalized),token,normalized.target_sha,normalized.tag_name]); if(inserted.rows?.[0])return{kind:'claimed',row:inserted.rows[0],attempt_token:token}; const row=(await dbBinding.query('SELECT * FROM github_release_receipts WHERE repo=$1 AND idempotency_key=$2',[normalized.repo,normalized.idempotency_key])).rows?.[0]; if(!row)throw Object.assign(new Error('release receipt disappeared during claim'),{code:'IDEMPOTENCY_UNAVAILABLE'}); if(row.request_sha256!==digest)return{kind:'conflict',row}; if(row.state==='succeeded')return{kind:'existing',row}; if(row.state==='partial'){const resumed=await dbBinding.query("UPDATE github_release_receipts SET state='processing',attempt_token=$3,updated_at=now() WHERE repo=$1 AND idempotency_key=$2 AND state='partial' RETURNING *",[normalized.repo,normalized.idempotency_key,token]);if(resumed.rows?.[0])return{kind:'claimed',row:resumed.rows[0],attempt_token:token,resumed:true};} const takeover=await dbBinding.query("UPDATE github_release_receipts SET attempt_token=$3,updated_at=now() WHERE repo=$1 AND idempotency_key=$2 AND state='processing' AND updated_at < now() - interval '30 seconds' RETURNING *",[normalized.repo,normalized.idempotency_key,token]); if(takeover.rows?.[0])return{kind:'claimed',row:takeover.rows[0],attempt_token:token,resumed:true}; return{kind:'in_progress',row}; },
    async markTag(n,a,e={}){await dbBinding.query("UPDATE github_release_receipts SET tag_created=true,tag_ref_node_id=COALESCE($4,tag_ref_node_id),updated_at=now() WHERE repo=$1 AND idempotency_key=$2 AND attempt_token=$3",[n.repo,n.idempotency_key,a,e.tag_ref_node_id||null]);},
    async markPartial(n,a,d={}){await dbBinding.query("UPDATE github_release_receipts SET state='partial',release_may_exist=(release_may_exist OR $4),last_error=$5,updated_at=now() WHERE repo=$1 AND idempotency_key=$2 AND attempt_token=$3",[n.repo,n.idempotency_key,a,Boolean(d.release_may_exist),String(d.error||'partial release mutation')]);},
    async abandon(n,a){await dbBinding.query("DELETE FROM github_release_receipts WHERE repo=$1 AND idempotency_key=$2 AND attempt_token=$3 AND state='processing' AND tag_created=false AND release_may_exist=false",[n.repo,n.idempotency_key,a]);},
    async succeed(n,a,r){await dbBinding.query("UPDATE github_release_receipts SET state='succeeded',release_id=$4,receipt=$5::jsonb,last_error=NULL,updated_at=now() WHERE repo=$1 AND idempotency_key=$2 AND attempt_token=$3",[n.repo,n.idempotency_key,a,r.release_id,JSON.stringify(r)]);}
  };
}

export async function createGithubRelease(input, options = {}) {
  let normalized;
  try { normalized = normalizeGithubReleaseRequest(input); }
  catch (error) { return fail(error.code || 'INVALID_REQUEST', error.message, error.details || {}, false); }
  const { idempotency_key: ignoredIdempotencyKey, ...semanticRequest } = normalized;
  const digest = await sha256Text(canonicalJson(semanticRequest));
  const store = options.receiptStore || null;
  let claim = null;
  if (store) {
    claim = await store.claim(normalized, digest);
    if (claim.kind === 'conflict') return fail('IDEMPOTENCY_CONFLICT', 'idempotency identity is already bound to a different semantic release request', { idempotency_key: normalized.idempotency_key }, false);
    if (claim.kind === 'in_progress') return fail('IDEMPOTENCY_IN_PROGRESS', 'the same release request is already in progress', { idempotency_key: normalized.idempotency_key }, false);
  }
  const attemptToken=claim?.attempt_token||null;
  const replayTagTrusted=Boolean(claim&&(claim.kind==='existing'||claim.row?.tag_created));
  const replayReleaseTrusted=Boolean(claim&&(claim.kind==='existing'||claim.row?.release_may_exist));
  const idempotentReplay=Boolean(claim&&(claim.kind==='existing'||claim.resumed));
  const rejectBeforeMutation=async(result)=>{ if(store&&attemptToken){ if(claim?.resumed||claim?.row?.tag_created||claim?.row?.release_may_exist) await store.markPartial(normalized,attemptToken,{release_may_exist:Boolean(claim?.row?.release_may_exist),error:result.error||'preflight rejected'}); else await store.abandon?.(normalized,attemptToken); } return result; };
  let mutated = false;
  let tagMayExist = false;
  try {
    let pre = await observe(options.apiClient, normalized);
    if (!pre.ok) return rejectBeforeMutation(pre);
    const preState = classify(pre, normalized);
    if (pre.tag && pre.tag_commit_sha !== normalized.target_sha) return rejectBeforeMutation(fail('GITHUB_RELEASE_TAG_CONFLICT', 'existing tag resolves to a different commit', { tag_name: normalized.tag_name, requested_sha: normalized.target_sha, observed_sha: pre.tag_commit_sha }, false));
    if (pre.release && !releaseMatches(pre.release, normalized)) return rejectBeforeMutation(fail('GITHUB_RELEASE_STATE_CONFLICT', 'existing release materially differs from the requested semantic outcome', { tag_name: normalized.tag_name, release_id: pre.release.id || null }, false));
    if (pre.release && !pre.tag) return rejectBeforeMutation(fail('GITHUB_RELEASE_STATE_CONFLICT', 'release exists but the corresponding Git tag is not authoritatively observable', { tag_name: normalized.tag_name, release_id: pre.release.id || null }, false));
    if (normalized.expected_state.tag === 'absent' && pre.tag && !replayTagTrusted) return rejectBeforeMutation(fail('GITHUB_RELEASE_STATE_CHANGED', 'tag expected absent but is present', { tag_name: normalized.tag_name, observed_state: preState }, false));
    if (normalized.expected_state.tag === 'present_same_commit' && !pre.tag) return rejectBeforeMutation(fail('GITHUB_RELEASE_STATE_CHANGED', 'tag expected present at requested commit but is absent', { tag_name: normalized.tag_name, observed_state: preState }, false));
    if (normalized.expected_state.release === 'absent' && pre.release && !replayReleaseTrusted) return rejectBeforeMutation(fail('GITHUB_RELEASE_STATE_CHANGED', 'release expected absent but is present', { tag_name: normalized.tag_name, observed_state: preState }, false));
    if (normalized.expected_state.release === 'present_matching' && !pre.release) return rejectBeforeMutation(fail('GITHUB_RELEASE_STATE_CHANGED', 'matching release expected present but is absent', { tag_name: normalized.tag_name, observed_state: preState }, false));

    if (pre.tag && pre.release) {
      const done = receipt(normalized, digest, pre, preState, 'already_satisfied', false, idempotentReplay);
      if (store) if(attemptToken) await store.succeed(normalized,attemptToken,done);
      return done;
    }

    if (!pre.tag) {
      let tagWrite;
      try { tagWrite = await api(options.apiClient, 'POST', `${pre.base}/git/refs`, { ref: `refs/tags/${normalized.tag_name}`, sha: normalized.target_sha }); }
      catch (error) {
        tagMayExist = true;
        if (store) await store.markPartial(normalized,attemptToken,{release_may_exist:false,error:error.message});
        return fail('GITHUB_RELEASE_INDETERMINATE', 'tag creation transport failed after dispatch', { tag_name: normalized.tag_name }, true);
      }
      if (!good(tagWrite)) {
        const rejected=fail(tagWrite.status===422?'GITHUB_RELEASE_TAG_CONFLICT':'GITHUB_RELEASE_INDETERMINATE','GitHub did not confirm immutable tag creation',{tag_name:normalized.tag_name,upstream_status:tagWrite.status},tagWrite.status>=500);
        if(tagWrite.status>=500){if(store)await store.markPartial(normalized,attemptToken,{release_may_exist:false,error:'tag create HTTP '+tagWrite.status});return rejected;}
        return rejectBeforeMutation(rejected);
      }
      mutated = true;
      tagMayExist = true;
      if (String(tagWrite.body?.object?.sha || '').toLowerCase() !== normalized.target_sha) {
        if (store) await store.markPartial(normalized,attemptToken,{release_may_exist:false,error:'tag write returned unexpected SHA'});
        return fail('GITHUB_RELEASE_VERIFICATION_FAILED', 'tag creation returned an unexpected target', { requested_sha: normalized.target_sha, observed_sha: tagWrite.body?.object?.sha || null }, true);
      }
      if (store) await store.markTag(normalized,attemptToken,{ tag_ref_node_id: tagWrite.body?.node_id || null });
    }

    if (!pre.release) {
      let releaseWrite;
      try { releaseWrite = await api(options.apiClient, 'POST', `${pre.base}/releases`, { tag_name: normalized.tag_name, name: normalized.name, body: normalized.body, draft: normalized.draft, prerelease: normalized.prerelease }); }
      catch (error) {
        if (store) await store.markPartial(normalized,attemptToken,{release_may_exist:true,error:error.message});
        return fail('GITHUB_RELEASE_INDETERMINATE', 'release creation transport failed after tag state was established', { tag_name: normalized.tag_name }, true);
      }
      if (!good(releaseWrite)) {
        if (store) await store.markPartial(normalized,attemptToken,{release_may_exist:releaseWrite.status>=500||releaseWrite.status===422,error:'release create HTTP '+releaseWrite.status});
        const permission = releaseWrite.status === 401 || releaseWrite.status === 403;
        const releaseMayHaveMutated = mutated || releaseWrite.status >= 500 || releaseWrite.status === 422;
        return fail(permission ? 'GITHUB_PERMISSION_DENIED' : 'GITHUB_RELEASE_INDETERMINATE', permission ? 'GitHub App lacks permission to create releases' : 'GitHub did not confirm release creation', { tag_name: normalized.tag_name, upstream_status: releaseWrite.status, ...(permission ? { required_permissions: { contents: 'write' } } : {}) }, releaseMayHaveMutated);
      }
      mutated = true;
    }

    const post = await observe(options.apiClient, normalized);
    if (!post.ok || !post.tag || post.tag_commit_sha !== normalized.target_sha || !releaseMatches(post.release, normalized)) {
      if (store) await store.markPartial(normalized,attemptToken,{release_may_exist:true,error:'post-write verification failed'});
      return fail('GITHUB_RELEASE_VERIFICATION_FAILED', 'authoritative post-write verification did not prove the requested tag and release state', { tag_name: normalized.tag_name, post_state: post.ok ? classify(post, normalized) : 'observation_failed' }, true);
    }
    const done = receipt(normalized, digest, post, preState, 'created', true, idempotentReplay);
    if (store) if(attemptToken) await store.succeed(normalized,attemptToken,done);
    return done;
  } catch (error) {
    if (store) {
      if (mutated || tagMayExist) await store.markPartial(normalized,attemptToken,{release_may_exist:mutated,error:error.message});
      else await store.abandon?.(normalized,attemptToken);
    }
    return fail(error.code || 'GITHUB_RELEASE_INDETERMINATE', error.message || 'release operation failed', { github_path: error.github_path || null }, mutated || tagMayExist || Boolean(error.mayHaveMutated));
  }
}

