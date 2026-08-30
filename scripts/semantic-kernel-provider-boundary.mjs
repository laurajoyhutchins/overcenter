const PROVIDER_PREFIXES = ['hatchable', '@aws-sdk/', '@google-cloud/', '@azure/'];

function matchProvider(specifier) {
  return PROVIDER_PREFIXES.find((prefix) => prefix.endsWith('/') ? specifier.startsWith(prefix) : specifier === prefix) ?? null;
}

export function findForbiddenProviderImports(files) {
  const violations = [];
  const pattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^'\"]*?\s+from\s+)?['\"]([^'\"]+)['\"]/g;
  for (const [path, source] of files) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      if (matchProvider(match[1])) violations.push({ path, provider: match[1] });
    }
  }
  return violations.sort((a, b) => a.path.localeCompare(b.path) || a.provider.localeCompare(b.provider));
}