const PROVIDER_PREFIXES = ['hatchable', '@aws-sdk/', '@google-cloud/', '@azure/'];
const ALLOWED_RUNTIME_COMPOSITION_MODULES = new Set([
  'portable-runtime',
  'production-promotion-overcenter-host',
]);
const IMPORT_PATTERN = /\b(?:import|export)\s+(?:type\s+)?(?:[^'\"]*?\s+from\s+)?['\"]([^'\"]+)['\"]/g;

function importedSpecifiers(source) {
  const specifiers = [];
  IMPORT_PATTERN.lastIndex = 0;
  for (let match = IMPORT_PATTERN.exec(source); match; match = IMPORT_PATTERN.exec(source)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function matchProvider(specifier) {
  return PROVIDER_PREFIXES.find((prefix) => prefix.endsWith('/') ? specifier.startsWith(prefix) : specifier === prefix) ?? null;
}

export function findForbiddenProviderImports(files) {
  const violations = [];
  for (const [path, source] of files) {
    for (const specifier of importedSpecifiers(source)) {
      const provider = matchProvider(specifier);
      if (provider) violations.push({ path, provider });
    }
  }
  return violations.sort((a, b) => a.path.localeCompare(b.path) || a.provider.localeCompare(b.provider));
}

function runtimeModule(specifier) {
  const normalized = specifier.replace(/\.(?:js|ts)$/, '');
  const marker = '/runtime/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return null;
  const target = normalized.slice(index + marker.length);
  return target && !target.includes('/') ? target : null;
}

export function findForbiddenRuntimeCompatibilityImports(files) {
  const violations = [];
  for (const [path, source] of files) {
    for (const specifier of importedSpecifiers(source)) {
      const module = runtimeModule(specifier);
      if (module && !ALLOWED_RUNTIME_COMPOSITION_MODULES.has(module)) {
        violations.push({ path, module, specifier });
      }
    }
  }
  return violations.sort((a, b) => a.path.localeCompare(b.path) || a.specifier.localeCompare(b.specifier));
}