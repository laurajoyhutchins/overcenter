# Contract Evidence Protocol Design

Status: Approved design, pending written-spec review  
Date: 2026-09-01

## Summary

Overcenter needs a mechanically complete inventory of structured data contracts without creating a second schema system or turning repository-specific implementation details into false public API commitments.

This design introduces a generic contract-evidence protocol. Managed repositories provide technology-specific discoverers that observe their own contract surfaces. Those discoverers emit a standard candidate model. A deterministic compiler identifies and classifies candidates, resolves authority and projection relationships, emits a canonical catalog and human documentation, and verifies that contract coverage never regresses.

Overcenter is the first repository to implement and dogfood the protocol. Its first discoverers cover TypeScript semantic sources, runtime schemas/descriptors, MCP and HTTP boundaries, repository-owned structured data, and the final PostgreSQL schema after migrations. The protocol itself is not TypeScript-, PostgreSQL-, MCP-, HTTP-, or Overcenter-specific.

The rollout uses no committed debt baseline and no temporary migration mode. CI compares the exact set of unclassified contract identities at the merge base with the candidate head and requires:

```text
candidate_unclassified ⊆ merge_base_unclassified
```

When the merge-base set eventually reaches the empty set, the same invariant permanently enforces zero unclassified contracts. No ratchet state, sunset flag, baseline file, or cleanup PR remains.

## Product Boundary

The capability is split deliberately:

```text
managed repository
    |
    +-- repository-specific discoverers
    |     TypeScript / Python / OpenAPI / SQL / protobuf / ...
    |
    v
standard contract candidate interface
    |
    v
contract catalog compiler
    |
    +-- generated catalog
    +-- generated documentation
    +-- compatibility metadata
    +-- verification evidence
    |
    v
Overcenter or another consumer
```

The managed repository owns knowledge of how contracts are represented in that repository. The protocol owns stable identities, classification semantics, logical-contract relationships, catalog structure, comparison semantics, and verification rules. Overcenter may consume the resulting evidence for project transitions, compatibility analysis, SemVer work, or other deterministic checks.

Overcenter must not become a parser for every language or framework a managed repository might use.

## Goals

1. Mechanically inventory every discoverable structured contract in a participating repository.
2. Classify contracts by architectural significance rather than treating every structured shape as public API.
3. Represent one logical contract once even when it has multiple source or transport projections.
4. Detect new unclassified contract debt deterministically in CI.
5. Let historical unclassified debt shrink without preserving permanent migration scaffolding.
6. Produce deterministic machine-readable and human-readable contract documentation.
7. Expose contract-change facts to existing SemVer machinery without making speculative compatibility judgments in v1.
8. Fail closed when inventory evidence is incomplete or internally inconsistent.
9. Keep the compiler outside the application runtime so execution correctness does not depend on documentation machinery.
10. Make the protocol reusable by repositories other than Overcenter.

## Non-goals for v1

The first version will not:

- introduce a universal schema DSL;
- migrate existing contracts to Zod, TypeBox, JSON Schema, or another single schema framework;
- infer semantic-version bumps automatically;
- parse migration history as the authoritative database schema;
- infer rich inner schemas for arbitrary JSON or JSONB values without an existing linked contract;
- generate runtime application code from the catalog;
- generate one documentation file per contract;
- add a contract database or service;
- add contract dependency visualizations;
- add special code that must later be deleted when historical debt reaches zero.

## Architectural Principles

### Observation, not duplication

Discoverers observe existing authoritative sources. The catalog must not become another place where contract fields, types, constraints, or allowed values are manually restated.

### Mechanical discovery, intentional classification

Software should discover candidate contracts. Humans or repository-owned policy should classify the architectural significance software cannot safely infer.

### One logical contract, many projections

A TypeScript type, runtime validator, generated JavaScript mirror, MCP input schema, HTTP schema, and durable representation may all describe one logical contract. The catalog should retain the provenance of each manifestation while resolving them to one logical identity where appropriate.

### Stable identity is separate from structure

A contract's source identity must survive ordinary field edits. Structural changes alter a fingerprint, not the identity. This lets CI distinguish "the same contract changed" from "a new unclassified contract appeared."

### Fail closed on incomplete evidence

A successful catalog means every configured discoverer completed and all cross-references resolved. Partial inventory presented as complete is a correctness failure.

### Repository correctness, not runtime orchestration

The compiler is repository verification machinery. If it were removed, Overcenter's runtime should continue functioning. What disappears is the repository's ability to prove that its contract inventory is complete and current.

## Core Pipeline

```text
source discoverers
      |
      v
raw candidates
      |
      v
identity + classification resolver
      |
      v
logical contract graph
      |
      +--> catalog.json
      +--> data-contracts.md
      +--> SemVer/change facts
      +--> CI verification evidence
```

Each layer has one job and communicates through a small explicit model.

## Discovery

### Generic discoverer interface

A discoverer is a read-only observer for one source family. It emits candidate records and discovery diagnostics. It does not decide compatibility significance and does not write repository state.

Each candidate must provide at minimum:

```text
source_identity
source_kind
source_location
symbol_or_boundary
structural_fingerprint
observed_relationships
```

The protocol should define these fields and their normalization rules independent of any particular language.

### Overcenter v1 discoverers

The first implementation should cover:

1. **TypeScript semantic declarations**
   - exported domain types and contract-bearing declarations in authoritative source;
   - runtime-bearing semantic modules under the accepted TypeScript ownership boundary;
   - generated JavaScript mirrors recognized as projections rather than independent authorities.

2. **Runtime schemas and semantic descriptors**
   - descriptor registries and schema-like objects that define caller-visible or execution-relevant validation;
   - relationships to corresponding TypeScript declarations where they can be established deterministically.

3. **MCP and HTTP boundaries**
   - input/output schemas and structured external boundaries;
   - adapters treated as projections when they expose a logical contract defined elsewhere.

4. **Repository-owned structured data**
   - project-definition and other repo-owned structured formats that cross authority boundaries or participate in durable project semantics.

5. **PostgreSQL final schema**
   - apply all migrations to a clean PostgreSQL 16 database;
   - introspect the resulting catalog through PostgreSQL metadata;
   - discover tables, columns, enum/domain types, constraints, and relevant views;
   - do not treat migration files individually as final schema authority.

A JSONB column is a durable contract only at the granularity proven by available evidence. If no richer linked schema exists, the compiler records that the durable field stores JSON, rather than inventing an inner structure.

### Generated artifacts

Mechanically generated artifacts should normally be linked automatically to their source authority and should not require manual classification. The compiler must avoid doubling the apparent contract surface by counting generated mirrors as separate logical APIs.

## Identity and Fingerprints

### Source identity

A source identity should be stable across ordinary edits and specific enough to avoid collisions. Example shapes:

```text
typescript:src/semantic/work-settle-contract.ts#WorkSettleInput
mcp:mcp/work.settle.js#inputSchema
postgres:public.orchestration_runs#status
http:api/project/advance#request
```

These examples are illustrative. The implementation should centralize canonicalization rules so discoverers do not invent subtly incompatible identity formats.

### Structural fingerprint

The fingerprint is computed from a canonical normalized representation of the discovered structure. The normalization must be deterministic and remove irrelevant ordering or formatting differences.

Changing a contract's fields, constraints, or equivalent structural facts changes the fingerprint while preserving source identity.

Fingerprints are evidence that a structure changed. They are not, by themselves, a judgment that the change is major, minor, patch, compatible, or incompatible.

## Classification

Classification is sparse repository-owned metadata. It stores only facts that cannot be derived safely from the authoritative contract itself.

Each classified candidate resolves to one logical contract and one significance class:

- `public`
- `authority`
- `durable-internal`
- `boundary-internal`
- `projection`
- `implementation-only`

A classification may additionally record:

- logical contract ID;
- `projection_of` relationship;
- an applicable existing SemVer compatibility kind;
- narrowly scoped repository-specific policy metadata when necessary.

It must not restate:

- contract fields;
- field types;
- allowed values;
- runtime validation rules;
- database constraints already present in authoritative sources.

### Example

```text
typescript:src/semantic/work-settle-contract.ts#WorkSettleInput
  logical_contract: work.settle.input
  significance: public
  semver_kind: semantic-command-contract
```

A projection may look like:

```text
mcp:mcp/work.settle.js#inputSchema
  logical_contract: work.settle.input
  significance: projection
  projection_of: work.settle.input
```

The exact serialized format should be chosen during implementation planning, but it must remain metadata-only rather than becoming a second schema definition language.

## Logical Contract Resolution

The resolver combines source candidates and classifications into a logical contract graph.

The graph must enforce these invariants:

1. Every discovered candidate is classified or belongs to the merge-base historical unclassified set allowed by the CI ratchet.
2. Every projection resolves to exactly one logical contract authority.
3. Logical contract identities are unique.
4. A logical contract has exactly one authority unless a deliberately modeled multi-authority rule exists.
5. Generated mirrors cannot silently become authorities.
6. Dangling source, projection, or logical-contract references fail verification.

The initial design should prefer a single authority. Multi-authority contracts should not be added speculatively.

## Generated Outputs

Keep the initial output surface small:

```text
generated/contracts/catalog.json
docs/generated/data-contracts.md
```

### `catalog.json`

This is the canonical generated machine artifact. It should contain enough normalized information to answer:

- what logical contracts exist;
- where each was discovered;
- which source is authoritative;
- which manifestations are projections;
- how each is classified;
- what its structural fingerprint is;
- whether a SemVer compatibility kind applies;
- whether the candidate is currently unclassified;
- which protocol/catalog schema version produced the artifact.

The catalog should use deterministic ordering and serialization.

### `data-contracts.md`

This is a deterministic rendering of the machine catalog for humans. It should group contracts by significance, including where relevant:

```text
Public compatibility contracts
Authority/internal contracts
Durable internal contracts
Boundary-internal contracts
Implementation-only shapes
Unclassified historical debt
```

The final heading is emitted only when the unclassified set is non-empty. When debt reaches zero it disappears naturally from generated documentation.

Do not generate per-contract Markdown files in v1.

## Historical Debt Ratchet

### Required invariant

CI compares the exact source-identity set of unclassified candidates at the merge base and candidate head:

```text
candidate_unclassified ⊆ merge_base_unclassified
```

This is set inclusion, not a count comparison.

Therefore this passes:

```text
base:      {A, B, C}
candidate: {A, C}
```

and this fails even though the counts match:

```text
base:      {A, B, C}
candidate: {A, B, D}
```

`D` is new debt and cannot hide behind removal of `C`.

### Self-eliminating rollout behavior

No baseline file is committed. No migration-complete bit exists. No branch of the compiler behaves differently after cleanup.

While historical debt exists, the merge base itself supplies the only permitted unclassified identities.

Eventually:

```text
merge_base_unclassified = {}
```

The unchanged rule becomes:

```text
candidate_unclassified ⊆ {}
```

which is equivalent to:

```text
candidate_unclassified = {}
```

At that point no ratchet-specific state survives. The transitional behavior has disappeared mathematically rather than through cleanup code.

## CI Flow

For every pull request that can change contract-bearing source:

```text
1. Resolve the exact merge base.
2. Generate a complete catalog from the merge base.
3. Generate a complete catalog from candidate HEAD.
4. Require candidate_unclassified ⊆ merge_base_unclassified.
5. Validate logical identities and authority/projection relationships.
6. Validate discoverer completion and diagnostics.
7. Validate deterministic output.
8. Regenerate candidate committed artifacts.
9. Diff generated catalog/docs against repository contents.
```

The merge-base and head generations must run against their own source state. Database discovery therefore requires applying each revision's migrations to an isolated clean PostgreSQL instance or database before introspection.

The existing Overcenter CI pattern of generating TypeScript runtime materialization and byte-diffing it against committed output is the precedent: committed generated artifacts are verified products of authoritative source, not hand-maintained mirrors.

## SemVer Integration

The catalog should expose compatibility facts but avoid compatibility judgment in v1.

For a public logical contract, the catalog or comparison output can provide facts such as:

```text
logical_contract: work.settle.input
semver_kind: semantic-command-contract
base_fingerprint: abc123
head_fingerprint: def456
changed: true
```

This can feed Overcenter's semantic-versioning machinery.

Deterministic software should identify what changed, where it changed, and which declared compatibility surface is involved. It should not guess at nuanced major/minor/patch meaning where semantics require judgment.

Obvious structural compatibility rules may be added later as a separate feature after the inventory protocol is proven.

## Failure Semantics

The compiler fails closed when any configured evidence source cannot be trusted. Examples include:

- a discoverer crashes or reports incomplete traversal;
- TypeScript analysis cannot parse required source;
- PostgreSQL migrations fail;
- PostgreSQL introspection cannot complete;
- two candidates resolve to one supposedly unique source identity;
- a projection references a missing authority;
- a classification references a missing candidate or logical contract;
- multiple authorities appear where only one is permitted;
- generated output is nondeterministic;
- candidate HEAD introduces a new unclassified identity;
- committed generated artifacts do not match regeneration.

A failed discoverer must never be treated as an empty result set.

## Testing Strategy

### Discovery coverage

Tests must prove representative discovery for:

- TypeScript contract declarations;
- runtime descriptors or schemas;
- MCP or HTTP boundary contracts;
- repository-owned structured data;
- migrated PostgreSQL schema;
- generated runtime mirrors recognized as projections rather than duplicate authorities.

### Logical resolution

Tests must prove:

- TypeScript, runtime schema, and transport projection can resolve to one logical contract;
- dangling projections fail;
- duplicate logical authorities fail;
- duplicate source identities fail;
- implementation-only candidates remain inventoried without being promoted to public compatibility surfaces.

### Historical ratchet

Tests must prove:

- removing an unclassified candidate passes;
- classifying an existing unclassified candidate passes;
- replacing old debt with different new debt fails;
- adding any new unclassified identity fails;
- an empty merge-base set permanently requires an empty candidate set.

### Determinism

Repeated runs against identical input must produce byte-identical generated output. Filesystem traversal order, object-key iteration, and database query order must not affect the result.

### Failure closure

Tests must inject failed discoverers, broken migrations, malformed classification metadata, and unresolved relationships and verify that the compiler fails rather than silently degrading coverage.

## Rollout

### Phase 1: protocol and Overcenter dogfood

Implement the generic candidate/catalog models, comparison invariant, and deterministic compiler interfaces. Add Overcenter-specific discoverers and generate the first complete catalog.

The initial catalog may contain historical unclassified debt. That set is accepted only because it exists at the merge base.

### Phase 2: classification cleanup

Classify existing candidates in narrow independent changes. Each cleanup may reduce the historical set. CI prevents any new identity from entering it.

No special final migration is scheduled.

### Phase 3: zero debt

When the unclassified set reaches zero, the ordinary set-inclusion rule becomes a permanent zero-debt gate automatically.

### Phase 4: managed-repository adoption

Other repositories may adopt the protocol by supplying discoverers for their own technology stack and emitting the same catalog contract. Overcenter can then consume their contract evidence without learning how to parse each repository's source languages or frameworks.

## Success Criteria

The design is successful when:

1. Overcenter can mechanically produce a complete inventory of configured contract-bearing sources.
2. Each discovered manifestation is either classified or explicitly visible as historical debt.
3. New unclassified debt cannot merge.
4. Historical debt can only shrink and eventually reaches zero without cleanup machinery.
5. Generated catalog and documentation are deterministic and checked in CI.
6. Logical contracts distinguish authority from projections and avoid duplicate schema ownership.
7. Public compatibility contracts can be mapped to existing SemVer policy without treating internal implementation shapes as public API.
8. A second repository can adopt the protocol without importing Overcenter-specific TypeScript, MCP, HTTP, or PostgreSQL assumptions into the protocol core.
9. Overcenter runtime behavior remains independent of the catalog compiler.

## Design Decision

Adopt a **discovery-first compiler with sparse classification metadata and a merge-base historical ratchet**.

The protocol is generic from day one. Overcenter provides the first discoverer set and serves as the dogfood repository. The canonical artifact is a deterministic contract catalog; human documentation and compatibility facts are projections of that artifact. Historical unclassified debt is controlled by set inclusion against the merge base, so the migration mechanism requires no persistent baseline and disappears automatically when debt reaches zero.
