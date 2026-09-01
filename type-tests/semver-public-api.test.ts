import {
  SEMVER_INTERNAL_IMPLEMENTATION_KINDS,
  SEMVER_PUBLIC_API_KINDS,
  SEMVER_PUBLIC_API_POLICY,
  isSemverPublicApiKind,
  type SemverCompatibilityKind,
  type SemverInternalImplementationKind,
  type SemverPublicApiKind,
} from '../src/semantic/semver-public-api';

const publicKind: SemverPublicApiKind = 'semantic-command-contract';
const internalKind: SemverInternalImplementationKind = 'database-layout';
const compatibilityKinds: readonly SemverCompatibilityKind[] = [publicKind, internalKind];
const publicClassification: boolean = isSemverPublicApiKind(publicKind);
const internalClassification: boolean = isSemverPublicApiKind(internalKind);

void compatibilityKinds;
void publicClassification;
void internalClassification;
void SEMVER_PUBLIC_API_POLICY;

// @ts-expect-error internal implementation detail is not part of the SemVer public API
const invalidPublicKind: SemverPublicApiKind = 'runtime-host-detail';
void invalidPublicKind;

// @ts-expect-error public API kind is not an internal implementation classification
const invalidInternalKind: SemverInternalImplementationKind = 'project-horizon-schema';
void invalidInternalKind;

// @ts-expect-error public compatibility policy is immutable
SEMVER_PUBLIC_API_KINDS.push('semantic-command');

// @ts-expect-error internal compatibility policy is immutable
SEMVER_INTERNAL_IMPLEMENTATION_KINDS.push('database-layout');