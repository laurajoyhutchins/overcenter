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
