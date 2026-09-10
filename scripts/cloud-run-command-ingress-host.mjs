const GITHUB_APP_URL = 'https://api.github.com/app';
const GITHUB_API_VERSION = '2026-03-10';
const GITHUB_REPOSITORY = 'laurajoyhutchins/overcenter';
const GITHUB_REPOSITORY_INSTALLATION_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/installation`;
const GITHUB_DEV_REF_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/git/ref/heads/dev`;
const METADATA_IDENTITY_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';
const SHA_RE = /^[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function transportFailure(status, code, message, mayHaveMutated, details = undefined) {
  return {
    status,
    headers:{ 'content-type':'application/json' },
    bodyText:JSON.stringify({
      ok:false,
      error:code,
      error_code:code,
      message,
      error_class:'transport',
      retryable:false,
      may_have_mutated:mayHaveMutated,
      automatic_recovery_allowed:false,
      escalation_required:true,
      ...(details === undefined ? {} : { details }),
    }),
  };
}

function bearerToken(value) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(value || '').trim());
  return match ? match[1] : null;
}

function githubHeaders(token) {
  return {
    Accept:'application/vnd.github+json',
    Authorization:`Bearer ${token}`,
    'X-GitHub-Api-Version':GITHUB_API_VERSION,
    'User-Agent':'Overcenter-Command-Ingress/1.0',
  };
}

async function githubJson(url, init, unavailableMessage, { fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (cause) {
    throw Object.assign(new Error(unavailableMessage), { code:'GITHUB_SOURCE_AUTHORITY_UNAVAILABLE', status:503, cause });
  }
  if (!response.ok) {
    throw Object.assign(new Error(unavailableMessage), { code:'GITHUB_SOURCE_AUTHORITY_UNAVAILABLE', status:503, github_status:response.status });
  }
  return response.json();
}

export async function validateGitHubAppJwt(token, { fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(GITHUB_APP_URL, {
      method:'GET',
      headers:githubHeaders(token),
    });
  } catch (cause) {
    throw Object.assign(new Error('GitHub App identity validation transport failed'), {
      code:'GITHUB_APP_IDENTITY_UNAVAILABLE',
      status:503,
      cause,
    });
  }
  if (!response.ok) {
    throw Object.assign(new Error('GitHub App bearer credential was rejected'), {
      code:response.status === 401 || response.status === 403 ? 'GITHUB_APP_IDENTITY_INVALID' : 'GITHUB_APP_IDENTITY_UNAVAILABLE',
      status:response.status === 401 || response.status === 403 ? 401 : 503,
    });
  }
  const body = await response.json();
  return { appId:String(body?.id ?? '') };
}

export async function verifyGitHubSourceRevision(appJwt, expectedHead, { fetchImpl = fetch } = {}) {
  const installation = await githubJson(
    GITHUB_REPOSITORY_INSTALLATION_URL,
    { method:'GET', headers:githubHeaders(appJwt) },
    'GitHub App installation lookup failed',
    { fetchImpl },
  );
  const installationId = Number(installation?.id || 0);
  if (!Number.isSafeInteger(installationId) || installationId < 1) {
    throw Object.assign(new Error('GitHub App installation lookup returned no installation id'), { code:'GITHUB_SOURCE_AUTHORITY_UNAVAILABLE', status:503 });
  }
  const access = await githubJson(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    { method:'POST', headers:githubHeaders(appJwt) },
    'GitHub App installation token acquisition failed',
    { fetchImpl },
  );
  const installationToken = String(access?.token || '').trim();
  if (!installationToken) {
    throw Object.assign(new Error('GitHub App installation token acquisition returned no token'), { code:'GITHUB_SOURCE_AUTHORITY_UNAVAILABLE', status:503 });
  }
  const ref = await githubJson(
    GITHUB_DEV_REF_URL,
    { method:'GET', headers:githubHeaders(installationToken) },
    'GitHub dev source authority lookup failed',
    { fetchImpl },
  );
  const actualHead = String(ref?.object?.sha || '').trim().toLowerCase();
  if (!SHA_RE.test(actualHead)) {
    throw Object.assign(new Error('GitHub dev source authority returned an invalid revision'), { code:'GITHUB_SOURCE_AUTHORITY_UNAVAILABLE', status:503 });
  }
  return { matches:actualHead === expectedHead, actualHead };
}

export async function mintTargetIdentityToken(audience, { fetchImpl = fetch } = {}) {
  const url = new URL(METADATA_IDENTITY_URL);
  url.searchParams.set('audience', audience);
  url.searchParams.set('format', 'full');
  let response;
  try {
    response = await fetchImpl(url, {
      headers:{ 'Metadata-Flavor':'Google' },
    });
  } catch (cause) {
    throw Object.assign(new Error('GCP target identity token acquisition failed'), {
      code:'GCP_TARGET_IDENTITY_UNAVAILABLE',
      cause,
    });
  }
  if (!response.ok) {
    throw Object.assign(new Error('GCP target identity token acquisition failed'), {
      code:'GCP_TARGET_IDENTITY_UNAVAILABLE',
      status:response.status,
    });
  }
  const token = (await response.text()).trim();
  if (!token) throw Object.assign(new Error('GCP metadata server returned an empty identity token'), { code:'GCP_TARGET_IDENTITY_UNAVAILABLE' });
  return token;
}

function targetWorkerCommandUrl(audience) {
  const url = new URL(audience);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('targetAudience must be a clean HTTPS service origin');
  }
  url.pathname = '/api/worker-command';
  return url.toString();
}

export function createCommandIngressHandler(options = {}) {
  const expectedGitHubAppId = String(options.expectedGitHubAppId || '').trim();
  const targetAudience = String(options.targetAudience || '').trim().replace(/\/$/, '');
  if (!/^\d+$/.test(expectedGitHubAppId)) throw new TypeError('expectedGitHubAppId must be numeric');
  const targetUrl = targetWorkerCommandUrl(targetAudience);
  const validate = options.validateGitHubAppJwt || ((token) => validateGitHubAppJwt(token));
  const verifySourceRevision = options.verifyGitHubSourceRevision || ((token, expectedHead) => verifyGitHubSourceRevision(token, expectedHead));
  const mint = options.mintTargetIdentityToken || ((audience) => mintTargetIdentityToken(audience));
  const fetchTarget = options.fetchTarget || fetch;

  return async function handle(request = {}) {
    if (String(request.method || '').toUpperCase() !== 'POST') {
      return transportFailure(405, 'COMMAND_INGRESS_METHOD_NOT_ALLOWED', 'POST is required', false);
    }
    const token = bearerToken(request.authorization);
    if (!token) return transportFailure(401, 'COMMAND_INGRESS_AUTH_REQUIRED', 'GitHub App bearer credential is required', false);

    const expectedHead = String(request.expectedHead || '').trim().toLowerCase();
    if (!SHA_RE.test(expectedHead)) {
      return transportFailure(422, 'COMMAND_INGRESS_EXPECTED_HEAD_REQUIRED', 'A full 40-character expected dev revision is required', false);
    }
    const requestId = String(request.requestId || '').trim();
    if (!UUID_RE.test(requestId)) {
      return transportFailure(422, 'COMMAND_INGRESS_REQUEST_ID_REQUIRED', 'A UUID request id is required', false);
    }

    let identity;
    try {
      identity = await validate(token);
    } catch (error) {
      const status = Number(error?.status || 0) === 401 ? 401 : 503;
      return transportFailure(status, String(error?.code || 'GITHUB_APP_IDENTITY_UNAVAILABLE'), String(error?.message || 'GitHub App identity validation failed'), false);
    }
    if (String(identity?.appId || '') !== expectedGitHubAppId) {
      return transportFailure(403, 'GITHUB_APP_IDENTITY_MISMATCH', 'GitHub App identity does not match the configured Overcenter App', false);
    }

    let sourceRevision;
    try {
      sourceRevision = await verifySourceRevision(token, expectedHead);
    } catch (error) {
      return transportFailure(503, String(error?.code || 'GITHUB_SOURCE_AUTHORITY_UNAVAILABLE'), String(error?.message || 'GitHub source authority verification failed'), false);
    }
    if (!sourceRevision?.matches) {
      return transportFailure(409, 'COMMAND_INGRESS_STALE_REVISION', 'Expected revision no longer matches GitHub dev source authority', false, {
        expected_head:expectedHead,
        actual_head:String(sourceRevision?.actualHead || ''),
      });
    }

    let targetIdentityToken;
    try {
      targetIdentityToken = await mint(targetAudience);
    } catch (error) {
      return transportFailure(503, String(error?.code || 'GCP_TARGET_IDENTITY_UNAVAILABLE'), String(error?.message || 'GCP target identity token acquisition failed'), false);
    }

    let response;
    try {
      response = await fetchTarget(targetUrl, {
        method:'POST',
        headers:{
          Authorization:`Bearer ${targetIdentityToken}`,
          'content-type':'application/json',
          'x-overcenter-authority-mode':'authoritative',
          'x-overcenter-request-id':requestId,
          'x-overcenter-expected-head':expectedHead,
        },
        body:String(request.bodyText ?? ''),
      });
    } catch {
      return transportFailure(502, 'GCP_COMMAND_INGRESS_TRANSPORT_INDETERMINATE', 'Authoritative command transport failed after dispatch; execution outcome is indeterminate', true);
    }

    return {
      status:response.status,
      headers:{ 'content-type':response.headers.get('content-type') || 'application/json' },
      bodyText:await response.text(),
    };
  };
}
