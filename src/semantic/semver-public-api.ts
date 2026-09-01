export const SEMVER_PUBLIC_API_POLICY_SCHEMA = 'overcenter-semver-public-api-v1' as const;

export const SEMVER_PUBLIC_API_KINDS = Object.freeze([
  'semantic-command',
  'semantic-command-contract',
  'project-definition-schema',
  'project-horizon-schema',
  'public-evidence-schema',
  'external-error-semantics',
  'lifecycle-semantics',
] as const);

export type SemverPublicApiKind = (typeof SEMVER_PUBLIC_API_KINDS)[number];

export const SEMVER_INTERNAL_IMPLEMENTATION_KINDS = Object.freeze([
  'internal-module-layout',
  'database-layout',
  'runtime-host-detail',
  'adapter-layout',
  'behavior-preserving-refactor',
] as const);

export type SemverInternalImplementationKind = (typeof SEMVER_INTERNAL_IMPLEMENTATION_KINDS)[number];
export type SemverCompatibilityKind = SemverPublicApiKind | SemverInternalImplementationKind;

export const SEMVER_PUBLIC_API_POLICY = Object.freeze({
  schema:SEMVER_PUBLIC_API_POLICY_SCHEMA,
  public_kinds:SEMVER_PUBLIC_API_KINDS,
  internal_kinds:SEMVER_INTERNAL_IMPLEMENTATION_KINDS,
});

const PUBLIC_KINDS: ReadonlySet<SemverCompatibilityKind> = new Set(SEMVER_PUBLIC_API_KINDS);

export function isSemverPublicApiKind(kind: SemverCompatibilityKind): kind is SemverPublicApiKind {
  return PUBLIC_KINDS.has(kind);
}