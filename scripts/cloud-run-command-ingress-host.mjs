const GITHUB_APP_URL = 'https://api.github.com/app';
const GITHUB_API_VERSION = '2026-03-10';
const METADATA_IDENTITY_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

function transportFailure(status, code, message, mayHaveMutated) {
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
    }),
  };
}

function bearerToken(value) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(value || '').trim());
  return match ? match[1] : null;
}

export async function validateGitHubAppJwt(token, { fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(GITHUB_APP_URL, {
      method:'GET',
      headers:{
        Accept:'application/vnd.github+json',
        Authorization:`Bearer ${token}`,
        'X-GitHub-Api-Version':GITHUB_API_VERSION,
        'User-Agent':'Overcenter-Command-Ingress/1.0',
      },
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
  const mint = options.mintTargetIdentityToken || ((audience) => mintTargetIdentityToken(audience));
  const fetchTarget = options.fetchTarget || fetch;

  return async function handle(request = {}) {
    if (String(request.method || '').toUpperCase() !== 'POST') {
      return transportFailure(405, 'COMMAND_INGRESS_METHOD_NOT_ALLOWED', 'POST is required', false);
    }
    const token = bearerToken(request.authorization);
    if (!token) return transportFailure(401, 'COMMAND_INGRESS_AUTH_REQUIRED', 'GitHub App bearer credential is required', false);

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
