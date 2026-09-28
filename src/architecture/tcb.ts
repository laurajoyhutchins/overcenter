import type { DatabaseSync } from 'node:sqlite';

export interface EffectTrustRoot {
  effect_id: string;
  artifact_id: string;
  symbol_id: string;
  basis: 'effect' | 'authority' | 'capability';
  requirement_id: string;
}

interface TrustRootRow {
  effect_id: string;
  artifact_id: string;
  symbol_id: string;
  basis: EffectTrustRoot['basis'];
  requirement_id: string;
}

export function deriveEffectTrustRoots(db: DatabaseSync): EffectTrustRoot[] {
  return db
    .prepare(`
      WITH RECURSIVE
      required_authority(effect_id, authority_id) AS (
        SELECT effect_id, authority_id
        FROM effect_requires_authority
        UNION
        SELECT required_authority.effect_id, dependency.required_authority_id
        FROM required_authority
        JOIN authority_depends_on_authority AS dependency
          ON dependency.authority_id = required_authority.authority_id
      ),
      required_capability(effect_id, capability_id) AS (
        SELECT effect_id, capability_id
        FROM effect_requires_capability
        UNION
        SELECT required_capability.effect_id, dependency.required_capability_id
        FROM required_capability
        JOIN capability_depends_on_capability AS dependency
          ON dependency.capability_id = required_capability.capability_id
      ),
      roots(effect_id, artifact_id, symbol_id, basis, requirement_id) AS (
        SELECT
          required_authority.effect_id,
          symbol.artifact_id,
          implementation.symbol_id,
          'authority',
          required_authority.authority_id
        FROM required_authority
        JOIN symbol_implements_authority AS implementation USING(authority_id)
        JOIN symbol USING(symbol_id)

        UNION

        SELECT
          required_capability.effect_id,
          symbol.artifact_id,
          implementation.symbol_id,
          'capability',
          required_capability.capability_id
        FROM required_capability
        JOIN symbol_implements_capability AS implementation USING(capability_id)
        JOIN symbol USING(symbol_id)

        UNION

        SELECT
          implementation.effect_id,
          symbol.artifact_id,
          implementation.symbol_id,
          'effect',
          implementation.effect_id
        FROM symbol_performs_effect AS implementation
        JOIN symbol USING(symbol_id)
      )
      SELECT effect_id, artifact_id, symbol_id, basis, requirement_id
      FROM roots
      ORDER BY effect_id, artifact_id, symbol_id, basis, requirement_id
    `)
    .all() as unknown as TrustRootRow[];
}

export function trustRootsForEffect(db: DatabaseSync, effectId: string): EffectTrustRoot[] {
  return deriveEffectTrustRoots(db).filter((root) => root.effect_id === effectId);
}

export interface ArchitectureDispatchBinding {
  target: {
    artifact_id: string;
    symbol_id: string;
  };
  implementation: {
    artifact_id: string;
    symbol_id: string;
  };
}

export function deriveRuntimeDispatchBindings(
  db: DatabaseSync,
): ArchitectureDispatchBinding[] {
  return db
    .prepare(`
      SELECT
        target.artifact_id AS target_artifact_id,
        binding.symbol_id AS target_symbol_id,
        implementation.artifact_id AS implementation_artifact_id,
        binding.implementation_symbol_id AS implementation_symbol_id
      FROM symbol_dispatches_to_symbol AS binding
      JOIN symbol AS target ON target.symbol_id = binding.symbol_id
      JOIN symbol AS implementation
        ON implementation.symbol_id = binding.implementation_symbol_id
      ORDER BY
        target.artifact_id,
        binding.symbol_id,
        implementation.artifact_id,
        binding.implementation_symbol_id
    `)
    .all()
    .map((row) => {
      const value = row as {
        target_artifact_id: string;
        target_symbol_id: string;
        implementation_artifact_id: string;
        implementation_symbol_id: string;
      };
      return {
        target: {
          artifact_id: value.target_artifact_id,
          symbol_id: value.target_symbol_id,
        },
        implementation: {
          artifact_id: value.implementation_artifact_id,
          symbol_id: value.implementation_symbol_id,
        },
      };
    });
}

export interface AssurancePropertyTrustRoot {
  property_id: string;
  artifact_id: string;
  symbol_id: string;
  basis: 'authority' | 'capability' | 'effect';
  requirement_id: string;
}

interface AssurancePropertyTrustRootRow {
  property_id: string;
  artifact_id: string;
  symbol_id: string;
  basis: AssurancePropertyTrustRoot['basis'];
  requirement_id: string;
}

export function deriveAssurancePropertyTrustRoots(
  db: DatabaseSync,
): AssurancePropertyTrustRoot[] {
  return db
    .prepare(`
      WITH RECURSIVE
      required_authority(property_id, authority_id) AS (
        SELECT property_id, authority_id
        FROM assurance_property_requires_authority
        UNION
        SELECT required_authority.property_id, dependency.required_authority_id
        FROM required_authority
        JOIN authority_depends_on_authority AS dependency
          ON dependency.authority_id = required_authority.authority_id
      ),
      required_capability(property_id, capability_id) AS (
        SELECT property_id, capability_id
        FROM assurance_property_requires_capability
        UNION
        SELECT required_capability.property_id, dependency.required_capability_id
        FROM required_capability
        JOIN capability_depends_on_capability AS dependency
          ON dependency.capability_id = required_capability.capability_id
      ),
      roots(property_id, artifact_id, symbol_id, basis, requirement_id) AS (
        SELECT
          required_authority.property_id,
          symbol.artifact_id,
          implementation.symbol_id,
          'authority',
          required_authority.authority_id
        FROM required_authority
        JOIN symbol_implements_authority AS implementation USING(authority_id)
        JOIN symbol USING(symbol_id)

        UNION

        SELECT
          required_capability.property_id,
          symbol.artifact_id,
          implementation.symbol_id,
          'capability',
          required_capability.capability_id
        FROM required_capability
        JOIN symbol_implements_capability AS implementation USING(capability_id)
        JOIN symbol USING(symbol_id)

        UNION

        SELECT
          required_effect.property_id,
          symbol.artifact_id,
          implementation.symbol_id,
          'effect',
          required_effect.effect_id
        FROM assurance_property_requires_effect_implementation AS required_effect
        JOIN symbol_performs_effect AS implementation USING(effect_id)
        JOIN symbol USING(symbol_id)
      )
      SELECT property_id, artifact_id, symbol_id, basis, requirement_id
      FROM roots
      ORDER BY property_id, artifact_id, symbol_id, basis, requirement_id
    `)
    .all() as unknown as AssurancePropertyTrustRootRow[];
}

export interface AssurancePropertyComposition {
  property_id: string;
  required_property_id: string;
}

export function deriveAssurancePropertyCompositions(
  db: DatabaseSync,
): AssurancePropertyComposition[] {
  return db
    .prepare(`
      SELECT property_id, required_property_id
      FROM assurance_property_composes_with
      ORDER BY property_id, required_property_id
    `)
    .all() as unknown as AssurancePropertyComposition[];
}
