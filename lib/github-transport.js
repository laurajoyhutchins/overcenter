const RETRYABLE_SAFE_READ_STATUSES = new Set([429, 500, 502, 503, 504]);

export function githubHeader(headers, name) {
  if (!headers) return null;
  const target = String(name).toLowerCase();
  if (typeof headers.get === 'function') {
    const value = headers.get(name) ?? headers.get(target);
    return value === null || value === undefined ? null : String(value);
  }
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target && value !== null && value !== undefined) return String(value);
  }
  return null;
}

export function isRetryableSafeReadStatus(status) {
  return RETRYABLE_SAFE_READ_STATUSES.has(Number(status || 0));
}

function retryDelayMs(headers, attempt, random) {
  const retryAfter = githubHeader(headers, 'retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5000, seconds * 1000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, Math.min(5000, at - Date.now()));
  }
  const base = Math.min(750, 100 * (2 ** Math.max(0, attempt - 1)));
  return Math.round(base + base * 0.25 * Math.max(0, Math.min(1, Number(random()))));
}

export async function boundedSafeRead(operation, options = {}) {
  const maxAttempts = Math.max(1, Math.min(5, Number(options.maxAttempts || 3)));
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const random = options.random || Math.random;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const response = await operation(attempts);
      if (!isRetryableSafeReadStatus(response?.status) || attempts >= maxAttempts) {
        return { response, attempts };
      }
      await sleep(retryDelayMs(response?.headers, attempts, random));
    } catch (error) {
      const status = Number(error?.status || 0);
      if ((status && !isRetryableSafeReadStatus(status)) || attempts >= maxAttempts) {
        if (error && typeof error === 'object') error.githubTransportAttempts = attempts;
        throw error;
      }
      await sleep(retryDelayMs(error?.headers, attempts, random));
    }
  }

  throw new Error('boundedSafeRead exhausted unexpectedly');
}

export function githubTransportEvidence(response, options = {}) {
  return {
    phase: options.phase || null,
    github_path: options.path || null,
    status: Number(response?.status || 0) || null,
    github_request_id: githubHeader(response?.headers, 'x-github-request-id'),
    retry_after: githubHeader(response?.headers, 'retry-after'),
    attempts: Number(options.attempts || 1),
    may_have_mutated: Boolean(options.mayHaveMutated),
  };
}