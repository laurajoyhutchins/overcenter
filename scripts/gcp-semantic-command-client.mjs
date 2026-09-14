const MAX_RESPONSE_BYTES = 1024 * 1024;

function reject(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) reject('OVERCENTER_GCP_COMMAND_CONFIGURATION_REQUIRED', `${name} is required`, { field: name });
  return normalized;
}

function endpoint(serviceUrl) {
  const url = new URL(required(serviceUrl, 'serviceUrl'));
  if (url.protocol !== 'https:') reject('OVERCENTER_GCP_COMMAND_CONFIGURATION_INVALID', 'serviceUrl must use https');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/worker-command`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function parseBody(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    reject('OVERCENTER_COMMAND_RESPONSE_TOO_LARGE', 'Overcenter command response exceeds the bounded response size');
  }
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { reject('OVERCENTER_COMMAND_RESPONSE_INVALID', 'Overcenter command response is not valid JSON'); }
}

async function runGcpSemanticCommand({ serviceUrl, idToken, requestId, command, input, fetchImpl = fetch }) {
  const token = required(idToken, 'idToken');
  const semanticCommand = required(command, 'command');
  const semanticRequestId = required(requestId, 'requestId');
  const url = endpoint(serviceUrl);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-overcenter-authority-mode': 'authoritative',
        'x-overcenter-request-id': semanticRequestId,
      },
      body: JSON.stringify({ command: semanticCommand, input }),
    });
  } catch (error) {
    reject(
      'OVERCENTER_COMMAND_OUTCOME_INDETERMINATE',
      `${semanticCommand} transport failed after dispatch; command outcome is indeterminate`,
      {
        command: semanticCommand,
        may_have_mutated: true,
        automatic_recovery_allowed: false,
        escalation_required: true,
        transport_error: String(error?.message || error),
      },
    );
  }

  let responseText;
  try { responseText = await response.text(); }
  catch (error) {
    reject('OVERCENTER_COMMAND_OUTCOME_INDETERMINATE', `${semanticCommand} response transport failed; command outcome is indeterminate`, {
      command: semanticCommand,
      may_have_mutated: true,
      automatic_recovery_allowed: false,
      escalation_required: true,
      transport_error: String(error?.message || error),
    });
  }
  const body = parseBody(responseText);
  if (response.status !== 200 || body?.ok !== true) {
    reject('OVERCENTER_COMMAND_FAILED', `${semanticCommand} failed`, {
      command: semanticCommand,
      status: response.status,
      body,
    });
  }
  return body;
}

export { runGcpSemanticCommand };
