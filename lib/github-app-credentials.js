function setupRequired(key, cause = null) {
  return Object.assign(
    new Error(`GitHub App credential ${key} is required.`),
    {
      code: 'GITHUB_APP_SETUP_REQUIRED',
      details: { key },
      ...(cause ? { cause } : {}),
    },
  );
}

function valueFromEnvironment(environment, key) {
  const value = typeof environment?.[key] === 'string' ? environment[key].trim() : '';
  return value || null;
}

export function createEnvironmentGitHubAppCredentialProvider(environment = globalThis.process?.env || {}) {
  return Object.freeze({
    async get(key) {
      const value = valueFromEnvironment(environment, key);
      if (!value) throw setupRequired(key);
      return value;
    },
  });
}

export function createDefaultGitHubAppCredentialProvider(environment = globalThis.process?.env || {}) {
  return Object.freeze({
    async get(key) {
      const environmentValue = valueFromEnvironment(environment, key);
      if (environmentValue) return environmentValue;

      try {
        const hatchable = await import('hatchable');
        const value = await hatchable.config?.get?.(key);
        const normalized = typeof value === 'string' ? value.trim() : '';
        if (normalized) return normalized;
      } catch (error) {
        if (error?.code === 'GITHUB_APP_SETUP_REQUIRED') throw error;
        throw setupRequired(key, error);
      }

      throw setupRequired(key);
    },
  });
}
