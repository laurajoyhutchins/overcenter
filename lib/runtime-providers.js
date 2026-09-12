function missing(provider, detail = null) {
  const error = new Error(`runtime provider ${provider} is required`);
  error.code = 'RUNTIME_PROVIDER_MISSING';
  error.details = { provider, ...(detail ? { detail } : {}) };
  throw error;
}

function requireObject(value, provider) {
  if (!value || typeof value !== 'object') return missing(provider);
  return value;
}

export function createRuntimeProviders(input = {}) {
  const db = requireObject(input.db, 'db');
  const secrets = requireObject(input.secrets, 'secrets');
  if (typeof secrets.get !== 'function') missing('secrets', 'get');
  const githubAppAuth = requireObject(input.githubAppAuth, 'githubAppAuth');
  if (typeof githubAppAuth.withApiClient !== 'function') missing('githubAppAuth', 'withApiClient');
  const storage = requireObject(input.storage, 'storage');
  if (typeof storage.get !== 'function') missing('storage', 'get');
  if (typeof storage.put !== 'function') missing('storage', 'put');
  const api = requireObject(input.api, 'api');
  if (typeof api.call !== 'function') missing('api', 'call');
  const executionTransactionStore = input.executionTransactionStore || null;
  return Object.freeze({ db, secrets, githubAppAuth, storage, api, executionTransactionStore });
}

export function runtimeProviderFailure(provider) {
  try {
    missing(provider);
  } catch (error) {
    return error;
  }
  return null;
}