import { createGitHubAppJwtFromSecrets } from './github-app-auth.js';

const CONTROL_REPO = 'laurajoyhutchins/overcenter';
const INGRESS_URL = 'https://overcenter-command-ingress-bwcce2cokq-uw.a.run.app';
const SHA40 = /^[0-9a-f]{40}$/;
const PROJECT_REF = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_COMMAND_INPUT_CHARS = 24000;

function invalid(message, details = {}) {
  return Object.assign(new Error(message), {
    code:'GCP_SEMANTIC_RELAY_INVALID',
    may_have_mutated:false,
    details,
  });
}

function normalizeProjectAmendInput(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const projectRef = String(input.project_ref || '').trim();
  const expectedRevision = String(input.expected_revision || '').trim().toLowerCase();
  if (!PROJECT_REF.test(projectRef)) throw invalid('project_ref must be a canonical github:owner/repo reference');
  if (!SHA40.test(expectedRevision)) throw invalid('expected_revision must be an exact 40-character Git SHA');
  if (!input.amendment || typeof input.amendment !== 'object' || Array.isArray(input.amendment)) throw invalid('amendment must be an object');
  const commandInput = { project_ref:projectRef, expected_revision:expectedRevision, amendment:input.amendment };
  if (JSON.stringify(commandInput).length > MAX_COMMAND_INPUT_CHARS) throw invalid('project.amend input is too large for the bounded GCP ingress');
  return Object.freeze({ project_ref:projectRef, expected_revision:expectedRevision, command_input:commandInput });
}

async function resolveControlPlaneHead(withGitHubAppApiClient) {
  if (typeof withGitHubAppApiClient !== 'function') throw invalid('GitHub App transport is unavailable');
  return withGitHubAppApiClient(CONTROL_REPO, async (apiClient) => {
    const response = await apiClient.call('github', {
      path:'/repos/laurajoyhutchins/overcenter/git/ref/heads/dev',
      method:'GET',
    });
    if (response?.status !== 200) {
      throw Object.assign(new Error('could not resolve exact Overcenter dev head for GCP semantic relay'), {
        code:'GCP_SEMANTIC_RELAY_HEAD_UNAVAILABLE',
        may_have_mutated:false,
        details:{ upstream_status:Number(response?.status || 0) || null },
      });
    }
    const revision = String(response?.body?.object?.sha || '').trim().toLowerCase();
    if (!SHA40.test(revision)) throw invalid('Overcenter dev head was not an exact Git revision');
    return revision;
  }, { permissionProfile:'project_facts' });
}

function directTransportFailure(error, requestId, expectedHead) {
  return Object.assign(new Error(`Direct GCP project.amend transport became indeterminate: ${String(error?.message || error)}`), {
    code:'GCP_SEMANTIC_DIRECT_TRANSPORT_INDETERMINATE',
    retryable:false,
    automatic_recovery_allowed:false,
    may_have_mutated:true,
    details:{ request_id:requestId, expected_head:expectedHead },
  });
}

export async function dispatchGcpProjectAmendViaIngress(input, options = {}) {
  const request = normalizeProjectAmendInput(input);
  const expectedHead = await resolveControlPlaneHead(options.withGitHubAppApiClient);
  const requestId = crypto.randomUUID();
  const appJwt = await createGitHubAppJwtFromSecrets({ secrets:options.secrets });
  const fetchImpl = options.fetchImpl || fetch;

  let response;
  let responseText;
  try {
    response = await fetchImpl(INGRESS_URL, {
      method:'POST',
      headers:{
        Authorization:`Bearer ${appJwt}`,
        'content-type':'application/json',
        'x-overcenter-request-id':requestId,
        'x-overcenter-expected-head':expectedHead,
      },
      body:JSON.stringify({ command:'project.amend', input:request.command_input }),
    });
    responseText = await response.text();
  } catch (error) {
    throw directTransportFailure(error, requestId, expectedHead);
  }

  try {
    return JSON.parse(responseText);
  } catch {
    throw directTransportFailure(new Error(`ingress returned non-JSON HTTP ${response.status}`), requestId, expectedHead);
  }
}
