function failure(code, message, { mayHaveMutated = false, automaticRecoveryAllowed } = {}) {
  return {
    ok: false,
    error: code,
    message: String(message || code),
    may_have_mutated: mayHaveMutated,
    retryable: false,
    ...(automaticRecoveryAllowed === undefined ? {} : { automatic_recovery_allowed: automaticRecoveryAllowed }),
  };
}

function ingressEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) return { error: failure('GCP_COMMAND_INGRESS_SETUP_REQUIRED', 'GCP command ingress URL is not configured.') };
  let url;
  try { url = new URL(raw); }
  catch { return { error: failure('GCP_COMMAND_INGRESS_SETUP_REQUIRED', 'GCP command ingress URL is invalid.') }; }
  if (url.protocol !== 'https:') return { error: failure('GCP_COMMAND_INGRESS_SETUP_REQUIRED', 'GCP command ingress URL must use HTTPS.') };
  if (url.username || url.password || url.search || url.hash) return { error: failure('GCP_COMMAND_INGRESS_SETUP_REQUIRED', 'GCP command ingress URL must not contain credentials, query, or fragment.') };
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return { url: url.toString() };
}

export function createGcpCommandForwarder(options = {}) {
  const mintCallerToken = options.mintCallerToken;
  const fetchImpl = options.fetchImpl || fetch;
  if (typeof mintCallerToken !== 'function') throw new TypeError('mintCallerToken is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');

  return Object.freeze({
    async execute(commandInput, input = {}) {
      const endpoint = ingressEndpoint(options.ingressUrl);
      if (endpoint.error) return endpoint.error;
      const command = String(commandInput || '').trim();
      if (!command) return failure('GCP_COMMAND_ADAPTER_INVALID', 'command is required');

      let callerToken;
      try { callerToken = await mintCallerToken(); }
      catch (error) {
        return failure(error?.code || 'GCP_COMMAND_CALLER_IDENTITY_UNAVAILABLE', error?.message || error);
      }
      if (!String(callerToken || '').trim()) return failure('GCP_COMMAND_CALLER_IDENTITY_UNAVAILABLE', 'GitHub App caller credential was empty.');

      const body = JSON.stringify({ command, input: input && typeof input === 'object' && !Array.isArray(input) ? input : {} });
      let response;
      try {
        response = await fetchImpl(endpoint.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${callerToken}`,
            'content-type': 'application/json',
          },
          body,
        });
      } catch (error) {
        return failure('GCP_COMMAND_ADAPTER_TRANSPORT_INDETERMINATE', error?.message || error, { mayHaveMutated:true, automaticRecoveryAllowed:false });
      }

      let text;
      try { text = await response.text(); }
      catch (error) {
        return failure('GCP_COMMAND_ADAPTER_RESPONSE_INDETERMINATE', error?.message || error, { mayHaveMutated:true, automaticRecoveryAllowed:false });
      }
      try { return text ? JSON.parse(text) : {}; }
      catch {
        return failure('GCP_COMMAND_ADAPTER_INVALID_RESPONSE', 'GCP command ingress returned a non-JSON response after dispatch.', { mayHaveMutated:true, automaticRecoveryAllowed:false });
      }
    },
  });
}
