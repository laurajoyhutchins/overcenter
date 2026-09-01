# Contract Evidence Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a generic, deterministic contract-evidence compiler and dogfood it in Overcenter so every configured contract surface is inventoried, classified, documented, compared across revisions, and prevented from accumulating new unclassified debt.

**Architecture:** Keep the protocol core as repository-verification tooling under `scripts/contract-evidence/`, isolated from the Overcenter runtime. Generic modules own candidate identity, canonicalization, classification resolution, logical-contract graphs, catalog rendering, revision comparison, and failure semantics; `scripts/contract-evidence/overcenter/` owns TypeScript, semantic descriptor, MCP/HTTP, repo-data, and PostgreSQL discovery. CI uses the candidate compiler to analyze both the merge-base source snapshot and candidate source snapshot, so the first rollout requires no committed baseline and later comparisons remain apples-to-apples under one discovery algorithm.

**Tech Stack:** Node.js 22 ESM, `node:test`, TypeScript compiler API 5.9.2 for JS/TS AST inspection, PostgreSQL 16, `pg` 8.13.1, Git CLI in CI, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-01-contract-evidence-protocol-design.md`

## Global Constraints

- The protocol core must not import Overcenter runtime modules or `hatchable`.
- Overcenter-specific source knowledge belongs under `scripts/contract-evidence/overcenter/`.
- Do not introduce Zod, TypeBox, JSON Schema generation, or another schema authority.
- Classification metadata stores identity/significance/projection/SemVer metadata only; it must not restate fields, types, allowed values, runtime validators, or database constraints.
- Generated runtime artifacts under `dist/` remain disposable and ignored; committed generated contract artifacts are only `generated/contracts/catalog.json` and `docs/generated/data-contracts.md`.
- Historical debt is governed only by `candidate_unclassified ⊆ merge_base_unclassified`; do not add a baseline file, migration-complete flag, sunset branch, or zero-debt cleanup path.
- Comparison is by exact source-identity set, never count alone.
- A failed configured discoverer is a hard failure, never an empty result.
- PostgreSQL authority is the final schema after applying migrations to a clean PostgreSQL 16 database, not migration-file text.
- SemVer integration reports facts (`semver_kind`, fingerprints, changed/not changed); v1 does not decide major/minor/patch.
- Managed repositories do not execute arbitrary discoverer code inside Overcenter. They run their own trusted discoverers and emit the shared catalog protocol; Overcenter consumes evidence rather than parsing every ecosystem.
- Follow current repo precedent: generated artifacts are mechanically regenerated and byte-diffed in CI, as the semantic runtime already does under `dist/lib`.

## File Structure

Create these generic protocol files:

- `scripts/contract-evidence/package.json` — isolated tooling dependencies (`typescript`, `pg`), no application runtime dependency.
- `scripts/contract-evidence/package-lock.json` — lock exact tooling dependency graph.
- `scripts/contract-evidence/model.mjs` — protocol schema constants and strict shape validation.
- `scripts/contract-evidence/canonical.mjs` — stable JSON canonicalization, source-identity normalization, SHA-256 structural fingerprints.
- `scripts/contract-evidence/resolver.mjs` — sparse classification loading, authority/projection resolution, logical-contract invariants.
- `scripts/contract-evidence/catalog.mjs` — deterministic catalog assembly and summary counts.
- `scripts/contract-evidence/compare.mjs` — unclassified-set ratchet and structural change facts.
- `scripts/contract-evidence/render-markdown.mjs` — deterministic human projection of the catalog.
- `scripts/contract-evidence/compiler.mjs` — discoverer orchestration and fail-closed diagnostics.
- `scripts/contract-evidence/cli.mjs` — `generate`, `check`, and `compare` entrypoints.

Create these Overcenter adapters:

- `scripts/contract-evidence/overcenter/config.mjs` — repo-specific roots, discoverer list, classification path, SemVer policy source.
- `scripts/contract-evidence/overcenter/typescript-discoverer.mjs` — exported TypeScript structured declarations plus generated-runtime projection facts.
- `scripts/contract-evidence/overcenter/semantic-descriptor-discoverer.mjs` — semantic command input-schema candidates derived from the typed descriptor source.
- `scripts/contract-evidence/overcenter/transport-discoverer.mjs` — MCP tool and HTTP route boundary candidates without executing adapters.
- `scripts/contract-evidence/overcenter/repo-data-discoverer.mjs` — repository-owned structured formats under `.overcenter/`.
- `scripts/contract-evidence/overcenter/postgres-discoverer.mjs` — migration application plus `pg_catalog` / `information_schema` introspection.
- `scripts/contract-evidence/overcenter/semver-policy.mjs` — extract allowed SemVer compatibility kinds from `src/semantic/semver-public-api.ts` using the TypeScript AST.

Create tests next to the implementation modules using `*.test.mjs`, plus fixture repositories under `scripts/contract-evidence/fixtures/`.

Create repository metadata and generated outputs:

- `.contract-evidence/classifications.json`
- `generated/contracts/catalog.json`
- `docs/generated/data-contracts.md`
- `.github/workflows/contract-evidence.yml`

Do not modify application runtime modules unless a discoverer test proves an existing source cannot be observed without adding non-duplicative metadata. If that happens, stop and re-enter design review rather than inventing a second contract declaration.

---

### Task 1: Generic candidate model and deterministic fingerprints

**Files:**
- Create: `scripts/contract-evidence/package.json`
- Create: `scripts/contract-evidence/package-lock.json`
- Create: `scripts/contract-evidence/model.mjs`
- Create: `scripts/contract-evidence/canonical.mjs`
- Create: `scripts/contract-evidence/model.test.mjs`
- Create: `scripts/contract-evidence/canonical.test.mjs`

**Interfaces:**
- Produces: `CONTRACT_CATALOG_SCHEMA`, `CONTRACT_CLASSIFICATION_SCHEMA`, `SIGNIFICANCE_CLASSES`, `assertCandidate()`, `assertClassificationDocument()`, `sourceIdentity()`, `canonicalJson()`, `fingerprintStructure()`.
- Consumes: Node 22 built-ins only for protocol core; `typescript` and `pg` are installed here for later adapters.

- [ ] **Step 1: Add the isolated tooling package and lock dependencies**

Create `scripts/contract-evidence/package.json`:

```json
{
  "name": "overcenter-contract-evidence-tooling",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "dependencies": {
    "pg": "8.13.1",
    "typescript": "5.9.2"
  },
  "scripts": {
    "test": "node --test *.test.mjs overcenter/*.test.mjs"
  }
}
```

Run:

```bash
npm install --prefix scripts/contract-evidence --package-lock-only --ignore-scripts
```

Expected: `scripts/contract-evidence/package-lock.json` pins `pg@8.13.1` and `typescript@5.9.2`.

- [ ] **Step 2: Write failing model tests**

In `model.test.mjs`, assert these public rules:

```js
assert.deepEqual(SIGNIFICANCE_CLASSES, [
  'public',
  'authority',
  'durable-internal',
  'boundary-internal',
  'projection',
  'implementation-only',
]);

assert.doesNotThrow(() => assertCandidate({
  source_identity:'typescript:src/example.ts#Example',
  source_kind:'typescript',
  source_location:{ path:'src/example.ts', anchor:'Example' },
  symbol_or_boundary:'Example',
  structural_fingerprint:'sha256:' + 'a'.repeat(64),
  structure:{ declaration_kind:'type' },
  observed_relationships:[],
}));

assert.throws(
  () => assertCandidate({ source_identity:'typescript:src/example.ts#Example' }),
  error => error?.code === 'CONTRACT_CANDIDATE_INVALID',
);
```

Also test that a classification document rejects field/schema duplication keys such as `properties`, `fields`, `allowed_values`, or `validation` with `CONTRACT_CLASSIFICATION_SCHEMA_DUPLICATION`.

- [ ] **Step 3: Run the model test and verify failure**

Run:

```bash
node --test scripts/contract-evidence/model.test.mjs
```

Expected: FAIL because `model.mjs` does not exist.

- [ ] **Step 4: Implement the strict model**

Use these exact schema identifiers:

```js
export const CONTRACT_CATALOG_SCHEMA = 'contract-evidence-catalog-v1';
export const CONTRACT_CLASSIFICATION_SCHEMA = 'contract-evidence-classifications-v1';
export const SIGNIFICANCE_CLASSES = Object.freeze([
  'public',
  'authority',
  'durable-internal',
  'boundary-internal',
  'projection',
  'implementation-only',
]);
```

`assertCandidate()` must require all candidate fields shown in Step 2 and reject unknown non-extension keys. `assertClassificationDocument()` must require `{ schema, candidates }`, accept a missing file later as an empty document, and reject any classification entry containing schema-definition keys.

- [ ] **Step 5: Write failing canonicalization tests**

Prove object-key ordering and formatting do not affect fingerprints:

```js
assert.equal(canonicalJson({ b:2, a:{ d:4, c:3 } }), '{"a":{"c":3,"d":4},"b":2}');
assert.equal(
  fingerprintStructure({ type:'object', properties:{ b:{type:'string'}, a:{type:'number'} } }),
  fingerprintStructure({ properties:{ a:{type:'number'}, b:{type:'string'} }, type:'object' }),
);
assert.equal(
  sourceIdentity('typescript', 'src\\semantic\\foo.ts', 'Foo'),
  'typescript:src/semantic/foo.ts#Foo',
);
```

- [ ] **Step 6: Implement canonicalization and fingerprinting**

`canonicalJson()` recursively sorts object keys and preserves array order. `fingerprintStructure()` hashes canonical UTF-8 bytes using `createHash('sha256')` and returns `sha256:<64 lowercase hex>`. `sourceIdentity()` normalizes path separators to `/`, removes leading `./`, rejects `..`, and URI-encodes `#` inside anchors.

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --test scripts/contract-evidence/model.test.mjs scripts/contract-evidence/canonical.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/contract-evidence/package.json scripts/contract-evidence/package-lock.json scripts/contract-evidence/model.mjs scripts/contract-evidence/canonical.mjs scripts/contract-evidence/model.test.mjs scripts/contract-evidence/canonical.test.mjs
git commit -m "feat: define contract evidence model"
```

---

### Task 2: Classification resolver and logical-contract graph

**Files:**
- Create: `scripts/contract-evidence/resolver.mjs`
- Create: `scripts/contract-evidence/resolver.test.mjs`
- Create: `scripts/contract-evidence/fixtures/classifications-valid.json`
- Create: `scripts/contract-evidence/fixtures/classifications-invalid.json`

**Interfaces:**
- Consumes: `assertCandidate()`, `assertClassificationDocument()` from Task 1.
- Produces: `loadClassifications(path)`, `resolveLogicalContracts(candidates, classificationDocument)`, `unclassifiedSourceIdentities(resolution)`.

- [ ] **Step 1: Write resolver tests for authority, projection, and unclassified candidates**

Use three candidates representing one logical input contract plus one historical internal shape:

```js
const candidates = [
  candidate('typescript:src/semantic/work-settle-contract.ts#WorkSettleInput'),
  candidate('mcp:mcp/work.settle.js#inputSchema'),
  candidate('typescript:src/internal.ts#LegacyShape'),
];
```

Classification fixture:

```json
{
  "schema": "contract-evidence-classifications-v1",
  "candidates": {
    "typescript:src/semantic/work-settle-contract.ts#WorkSettleInput": {
      "logical_contract": "work.settle.input",
      "significance": "public",
      "semver_kind": "semantic-command-contract"
    },
    "mcp:mcp/work.settle.js#inputSchema": {
      "significance": "projection",
      "projection_of": "work.settle.input"
    }
  }
}
```

Assert that `work.settle.input` has exactly one authority and one projection, while `LegacyShape` remains in `unclassified_source_identities`.

- [ ] **Step 2: Add failing invariant tests**

Cover exact error codes:

```text
CONTRACT_DUPLICATE_SOURCE_IDENTITY
CONTRACT_PROJECTION_TARGET_MISSING
CONTRACT_MULTIPLE_AUTHORITIES
CONTRACT_CLASSIFICATION_SOURCE_MISSING
CONTRACT_PROJECTION_SEMVER_OVERRIDE
```

A projection must not define its own `semver_kind`; it inherits compatibility significance from its logical authority.

- [ ] **Step 3: Run and verify failure**

```bash
node --test scripts/contract-evidence/resolver.test.mjs
```

Expected: FAIL because resolver functions are missing.

- [ ] **Step 4: Implement classification loading**

`loadClassifications(path)` behavior is permanent, not bootstrap-specific:

```js
try {
  return assertClassificationDocument(JSON.parse(await readFile(path, 'utf8')));
} catch (error) {
  if (error?.code === 'ENOENT') {
    return { schema:CONTRACT_CLASSIFICATION_SCHEMA, candidates:{} };
  }
  throw error;
}
```

A missing file means “no classifications”; malformed existing metadata fails closed. This lets the first merge-base snapshot be analyzed without special migration state and makes later accidental deletion fail naturally because previously classified identities become unclassified.

- [ ] **Step 5: Implement logical resolution**

Rules:

```text
non-projection classification -> logical_contract required -> authority
projection classification     -> projection_of required -> projection
unclassified candidate         -> no logical authority assignment yet
```

Sort all candidates and logical contracts lexicographically by stable IDs before returning.

- [ ] **Step 6: Run tests**

```bash
node --test scripts/contract-evidence/resolver.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/contract-evidence/resolver.mjs scripts/contract-evidence/resolver.test.mjs scripts/contract-evidence/fixtures/classifications-valid.json scripts/contract-evidence/fixtures/classifications-invalid.json
git commit -m "feat: resolve contract authorities and projections"
```

---

### Task 3: Generic compiler, catalog, Markdown rendering, and comparison

**Files:**
- Create: `scripts/contract-evidence/compiler.mjs`
- Create: `scripts/contract-evidence/catalog.mjs`
- Create: `scripts/contract-evidence/render-markdown.mjs`
- Create: `scripts/contract-evidence/compare.mjs`
- Create: `scripts/contract-evidence/cli.mjs`
- Create: `scripts/contract-evidence/compiler.test.mjs`
- Create: `scripts/contract-evidence/compare.test.mjs`
- Create: `scripts/contract-evidence/render-markdown.test.mjs`

**Interfaces:**
- Consumes: Task 1 model/canonical functions and Task 2 resolver.
- Produces: `compileCatalog({ repoRoot, discoverers, classificationPath, semverKinds })`, `renderCatalogMarkdown(catalog)`, `compareCatalogs(base, head)`, CLI commands `generate`, `check`, `compare`.

- [ ] **Step 1: Write a fail-closed discoverer test**

Define one successful discoverer and one throwing discoverer:

```js
const failing = {
  name:'failing',
  async discover() { throw Object.assign(new Error('boom'), { code:'FIXTURE_BOOM' }); },
};
await assert.rejects(
  compileCatalog({ repoRoot, discoverers:[failing], classificationPath }),
  error => error?.code === 'CONTRACT_DISCOVERY_FAILED' && error.discoverer === 'failing',
);
```

Also test that `{ complete:false }` diagnostics fail with `CONTRACT_DISCOVERY_INCOMPLETE` instead of being treated as zero candidates.

- [ ] **Step 2: Write catalog determinism tests**

Two discoverers returning the same candidates in opposite orders must produce byte-identical `canonicalJson(catalog)` and the same summary counts.

Catalog top-level shape must be:

```js
{
  schema:'contract-evidence-catalog-v1',
  repository:{ root_marker:'.', revision:null },
  generated_by:{ protocol:'contract-evidence-catalog-v1' },
  candidates:[...],
  logical_contracts:[...],
  unclassified_source_identities:[...],
  summary:{ discovered, classified, unclassified, logical_contracts },
}
```

Do not include wall-clock timestamps; they break determinism.

- [ ] **Step 3: Write ratchet comparison tests**

Required cases:

```js
assert.equal(compareUnclassified(['A','B','C'], ['A','C']).ok, true);
assert.deepEqual(compareUnclassified(['A','B','C'], ['A','B','D']).new_unclassified, ['D']);
assert.equal(compareUnclassified([], []).ok, true);
assert.deepEqual(compareUnclassified([], ['A']).new_unclassified, ['A']);
```

`compareCatalogs()` must also emit changed logical contracts when an authority fingerprint differs:

```js
{
  logical_contract:'work.settle.input',
  semver_kind:'semantic-command-contract',
  base_fingerprint:'sha256:...',
  head_fingerprint:'sha256:...',
  changed:true
}
```

No major/minor/patch field exists.

- [ ] **Step 4: Write Markdown rendering tests**

Require headings in this order:

```text
# Data contracts
## Public compatibility contracts
## Authority/internal contracts
## Durable internal contracts
## Boundary-internal contracts
## Implementation-only shapes
```

Only emit `## Unclassified historical debt` when `unclassified_source_identities.length > 0`.

- [ ] **Step 5: Run focused tests and verify failure**

```bash
node --test scripts/contract-evidence/compiler.test.mjs scripts/contract-evidence/compare.test.mjs scripts/contract-evidence/render-markdown.test.mjs
```

Expected: FAIL because implementation modules are missing.

- [ ] **Step 6: Implement compiler and catalog assembly**

Discoverer contract:

```js
{
  name: 'typescript',
  async discover({ repoRoot }) {
    return { complete:true, candidates:[...], diagnostics:[] };
  }
}
```

Run all configured discoverers, validate every result, flatten candidates, then call the resolver. Do not swallow or downgrade diagnostics.

- [ ] **Step 7: Implement CLI**

Supported commands:

```text
node scripts/contract-evidence/cli.mjs generate --repo-root <path> --config <config.mjs> --catalog <catalog.json> --docs <data-contracts.md>
node scripts/contract-evidence/cli.mjs check    --repo-root <path> --config <config.mjs> --catalog <catalog.json> --docs <data-contracts.md>
node scripts/contract-evidence/cli.mjs compare  --base-catalog <base.json> --head-catalog <head.json>
```

`check` generates in memory and fails with `CONTRACT_GENERATED_ARTIFACT_STALE` when either committed file differs byte-for-byte. `compare` exits nonzero with `CONTRACT_NEW_UNCLASSIFIED` when set inclusion fails.

- [ ] **Step 8: Run tests**

```bash
node --test scripts/contract-evidence/compiler.test.mjs scripts/contract-evidence/compare.test.mjs scripts/contract-evidence/render-markdown.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/contract-evidence/compiler.mjs scripts/contract-evidence/catalog.mjs scripts/contract-evidence/render-markdown.mjs scripts/contract-evidence/compare.mjs scripts/contract-evidence/cli.mjs scripts/contract-evidence/compiler.test.mjs scripts/contract-evidence/compare.test.mjs scripts/contract-evidence/render-markdown.test.mjs
git commit -m "feat: compile and compare contract catalogs"
```

---

### Task 4: TypeScript discovery and generated runtime projections

**Files:**
- Create: `scripts/contract-evidence/overcenter/typescript-discoverer.mjs`
- Create: `scripts/contract-evidence/overcenter/typescript-discoverer.test.mjs`
- Create: `scripts/contract-evidence/fixtures/typescript-repo/src/contracts.ts`
- Create: `scripts/contract-evidence/fixtures/typescript-repo/tsconfig.semantic.runtime.json`
- Create: `scripts/contract-evidence/fixtures/typescript-repo/lib/contracts.js`

**Interfaces:**
- Consumes: TypeScript compiler API 5.9.2 and Task 1 candidate/fingerprint helpers.
- Produces: `createTypescriptDiscoverer(options)`.

- [ ] **Step 1: Write discovery tests for all exported structured declarations**

Fixture source:

```ts
export interface RequestShape { repo: string; force?: boolean }
export type ResultShape = { ok: boolean; revision: string };
export const REQUEST_SCHEMA = Object.freeze({
  type:'object',
  required:['repo'],
  properties:{ repo:{type:'string'} },
  additionalProperties:false,
} as const);
const LocalOnly = { ignored:true };
```

Expect candidates for `RequestShape`, `ResultShape`, and `REQUEST_SCHEMA`, but not the unexported local value. Use TypeScript's parser/printer to normalize declarations so formatting-only edits do not change fingerprints.

- [ ] **Step 2: Test generated compatibility projection inference**

Fixture `tsconfig.semantic.runtime.json` maps `src/contracts.ts` to `dist/lib/contracts.js`, while committed `lib/contracts.js` exists. Assert the discoverer emits:

```js
{
  source_identity:'javascript:lib/contracts.js#module',
  source_kind:'generated-javascript',
  observed_relationships:[{
    kind:'generated-projection-of',
    target:'typescript:src/contracts.ts#module',
  }],
  ...
}
```

The resolver must be able to auto-mark this generated candidate as a projection once the source module or declaration is classified; no manual classification entry is required for the generated mirror.

- [ ] **Step 3: Run test and verify failure**

```bash
cd scripts/contract-evidence && npm install --ignore-scripts && cd ../..
node --test scripts/contract-evidence/overcenter/typescript-discoverer.test.mjs
```

Expected: FAIL because the discoverer is missing.

- [ ] **Step 4: Implement recursive TypeScript source discovery**

Scan `src/**/*.ts`, excluding `*.test.ts`, declaration output, `dist/`, and `node_modules/`. Emit candidates for exported interfaces, type aliases, enums, and structured object/array constants. Use the AST, not regexes.

- [ ] **Step 5: Implement runtime projection inference from `tsconfig.semantic.runtime.json`**

Read `compilerOptions.rootDir`, `compilerOptions.outDir`, and explicit `include`. For each runtime-bearing TypeScript module, map the module-relative path to the compatibility mirror under `lib/` if that mirror exists. Emit an observed `generated-projection-of` relationship; never classify generated output as an authority.

- [ ] **Step 6: Run tests**

```bash
node --test scripts/contract-evidence/overcenter/typescript-discoverer.test.mjs scripts/dist-runtime-artifact-boundary.test.mjs
```

Expected: PASS. The existing dist-boundary test must remain green.

- [ ] **Step 7: Commit**

```bash
git add scripts/contract-evidence/overcenter/typescript-discoverer.mjs scripts/contract-evidence/overcenter/typescript-discoverer.test.mjs scripts/contract-evidence/fixtures/typescript-repo
git commit -m "feat: discover TypeScript contract candidates"
```

---

### Task 5: Semantic descriptor, MCP/HTTP, and repo-owned data discovery

**Files:**
- Create: `scripts/contract-evidence/overcenter/semantic-descriptor-discoverer.mjs`
- Create: `scripts/contract-evidence/overcenter/semantic-descriptor-discoverer.test.mjs`
- Create: `scripts/contract-evidence/overcenter/transport-discoverer.mjs`
- Create: `scripts/contract-evidence/overcenter/transport-discoverer.test.mjs`
- Create: `scripts/contract-evidence/overcenter/repo-data-discoverer.mjs`
- Create: `scripts/contract-evidence/overcenter/repo-data-discoverer.test.mjs`

**Interfaces:**
- Consumes: TypeScript AST utilities from Task 4; current authoritative sources including `src/semantic/semantic-command-descriptors.ts`, `mcp/*.js`, `api/**/*.js`, `.overcenter/project-definitions.json`, `.overcenter/definitions/**/*.json`.
- Produces: `createSemanticDescriptorDiscoverer()`, `createTransportDiscoverer()`, `createRepoDataDiscoverer()`.

- [ ] **Step 1: Write a semantic descriptor regression test around `work.settle`**

Parse `src/semantic/semantic-command-descriptors.ts` statically and require a candidate:

```text
semantic-command:work.settle#input
```

Its normalized structure must include the descriptor command, required fields, schema object, exposure, and surface derived from source. Also require an observed relationship to the TypeScript contract authority when the descriptor imports/reuses an explicit contract source.

Do not execute the semantic runtime to discover descriptors; discovery must work against an arbitrary checked-out source snapshot.

- [ ] **Step 2: Write an MCP projection test against `mcp/work.settle.js`**

Require discovery of:

```text
mcp:mcp/work.settle.js#inputSchema
```

The AST should resolve `inputSchema:WORK_SETTLE_INPUT_SCHEMA` through the import declaration far enough to record a relationship target, without importing or executing `mcp/work.settle.js`.

- [ ] **Step 3: Write generic HTTP boundary tests**

For every `api/**/*.js` module, emit at least one route-level boundary candidate with normalized structure containing:

```js
{
  path:'api/...',
  access:'public|member|admin|scheduler',
  methods:[...],
  request_paths:[...],
  response_shapes:[...]
}
```

Extract explicit `methods` exports, `req.body`, `req.query`, and `req.params` property paths, plus object-literal keys passed directly to `res.json(...)`. Do not fingerprint the full handler source; implementation-only edits must not churn the boundary fingerprint.

- [ ] **Step 4: Write repo-owned data tests**

Require candidates for:

```text
repo-data:.overcenter/project-definitions.json#project-definition-discovery-v1
repo-data:.overcenter/definitions/target-architecture.json#<declared schema value>
```

The discoverer must use each document's declared `schema` string as the anchor when present. JSON content is canonicalized structurally, not by source whitespace.

- [ ] **Step 5: Run focused tests and verify failure**

```bash
node --test scripts/contract-evidence/overcenter/semantic-descriptor-discoverer.test.mjs scripts/contract-evidence/overcenter/transport-discoverer.test.mjs scripts/contract-evidence/overcenter/repo-data-discoverer.test.mjs
```

Expected: FAIL because discoverers are missing.

- [ ] **Step 6: Implement all three static discoverers**

Use TypeScript's JS parser for `.js` files. Never dynamic-import MCP or API modules because those adapters may import `hatchable`, touch environment state, or bind runtime services.

For HTTP response discovery, only record statically visible object-literal shapes. When a handler returns an opaque variable or function result, record `{ opaque:true }` rather than inventing fields.

- [ ] **Step 7: Run focused and existing descriptor tests**

```bash
node --test scripts/contract-evidence/overcenter/semantic-descriptor-discoverer.test.mjs scripts/contract-evidence/overcenter/transport-discoverer.test.mjs scripts/contract-evidence/overcenter/repo-data-discoverer.test.mjs scripts/verify-semantic-command-descriptors.test.mjs scripts/verify-mcp-admission-contract.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/contract-evidence/overcenter/semantic-descriptor-discoverer.mjs scripts/contract-evidence/overcenter/semantic-descriptor-discoverer.test.mjs scripts/contract-evidence/overcenter/transport-discoverer.mjs scripts/contract-evidence/overcenter/transport-discoverer.test.mjs scripts/contract-evidence/overcenter/repo-data-discoverer.mjs scripts/contract-evidence/overcenter/repo-data-discoverer.test.mjs
git commit -m "feat: discover Overcenter boundary contracts"
```

---

### Task 6: PostgreSQL final-schema discovery

**Files:**
- Create: `scripts/contract-evidence/overcenter/postgres-discoverer.mjs`
- Create: `scripts/contract-evidence/overcenter/postgres-discoverer.test.mjs`
- Create: `scripts/contract-evidence/fixtures/postgres/migrations/001_create_example.sql`
- Create: `scripts/contract-evidence/fixtures/postgres/migrations/002_alter_example.sql`

**Interfaces:**
- Consumes: `pg@8.13.1`, PostgreSQL 16 connection environment, migration directory path.
- Produces: `applyMigrations(client, migrationsDir)`, `introspectPostgresContracts(client)`, `createPostgresDiscoverer(options)`.

- [ ] **Step 1: Write a migration-authority test**

Fixture migrations:

`001_create_example.sql`

```sql
CREATE TABLE example_contract (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  obsolete text
);
```

`002_alter_example.sql`

```sql
ALTER TABLE example_contract DROP COLUMN obsolete;
```

Test must assert the discovered final schema contains `id` and `payload` but no `obsolete` candidate. This proves migration text is not treated as final authority.

- [ ] **Step 2: Write introspection determinism tests**

Require candidates for table, column, enum/domain, check/foreign-key/unique constraints, and views when present. SQL queries must contain explicit `ORDER BY` clauses even though final candidate sorting also occurs in the compiler.

JSONB candidate structure must say only:

```js
{ data_type:'jsonb', nullable:false }
```

unless another discovered source links a richer contract to that column. Do not infer inner JSON fields from sample data or SQL usage.

- [ ] **Step 3: Run test against PostgreSQL 16 and verify failure**

Run with the same environment used by the existing portable CI job:

```bash
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=overcenter PGUSER=overcenter PGPASSWORD=overcenter \
  node --test scripts/contract-evidence/overcenter/postgres-discoverer.test.mjs
```

Expected: FAIL because the discoverer is missing.

- [ ] **Step 4: Implement migration application**

Read `migrations/*.sql` lexicographically and execute one migration file at a time against a fresh database/schema. Fail immediately on any SQL error with `CONTRACT_DATABASE_MIGRATION_FAILED` including the migration path.

Do not rely on Hatchable's private migration ledger. Contract CI owns an isolated throwaway database and can apply every file from scratch.

- [ ] **Step 5: Implement final-schema introspection**

Read from `pg_catalog` / `information_schema`, excluding PostgreSQL system schemas and temporary tooling schemas. Stable source identities include:

```text
postgres:public.orchestration_runs#table
postgres:public.orchestration_runs#status
postgres:public.some_enum#type
postgres:public.some_view#view
```

- [ ] **Step 6: Run tests**

```bash
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=overcenter PGUSER=overcenter PGPASSWORD=overcenter \
  node --test scripts/contract-evidence/overcenter/postgres-discoverer.test.mjs scripts/node-postgres-runtime.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/contract-evidence/overcenter/postgres-discoverer.mjs scripts/contract-evidence/overcenter/postgres-discoverer.test.mjs scripts/contract-evidence/fixtures/postgres
git commit -m "feat: discover migrated PostgreSQL contracts"
```

---

### Task 7: Overcenter configuration, sparse classification, and SemVer facts

**Files:**
- Create: `scripts/contract-evidence/overcenter/config.mjs`
- Create: `scripts/contract-evidence/overcenter/semver-policy.mjs`
- Create: `scripts/contract-evidence/overcenter/semver-policy.test.mjs`
- Create: `.contract-evidence/classifications.json`
- Create: `generated/contracts/catalog.json`
- Create: `docs/generated/data-contracts.md`

**Interfaces:**
- Consumes: all discoverers from Tasks 4-6 and `src/semantic/semver-public-api.ts`.
- Produces: the first real Overcenter contract catalog and human documentation.

- [ ] **Step 1: Write a SemVer policy extraction test**

Parse `src/semantic/semver-public-api.ts` and require these currently authoritative public values:

```text
semantic-command
semantic-command-contract
project-definition-schema
project-horizon-schema
public-evidence-schema
external-error-semantics
lifecycle-semantics
```

Also include the internal implementation kinds from the same source. The contract tooling must not duplicate this list in its own source.

- [ ] **Step 2: Implement `semver-policy.mjs` using the TypeScript AST**

Find `SEMVER_PUBLIC_API_KINDS` and `SEMVER_INTERNAL_IMPLEMENTATION_KINDS`, extract string literals from their array initializers, and return one `Set<string>`. Fail with `CONTRACT_SEMVER_POLICY_UNREADABLE` if either constant cannot be resolved.

- [ ] **Step 3: Create the Overcenter discoverer configuration**

`config.mjs` exports exactly:

```js
export default {
  classificationPath:'.contract-evidence/classifications.json',
  semverPolicySource:'src/semantic/semver-public-api.ts',
  discoverers:[
    createTypescriptDiscoverer({ sourceRoot:'src', runtimeTsconfig:'tsconfig.semantic.runtime.json', compatibilityRoot:'lib' }),
    createSemanticDescriptorDiscoverer({ source:'src/semantic/semantic-command-descriptors.ts' }),
    createTransportDiscoverer({ mcpRoot:'mcp', apiRoot:'api' }),
    createRepoDataDiscoverer({ roots:['.overcenter/project-definitions.json', '.overcenter/definitions'] }),
    createPostgresDiscoverer({ migrationsRoot:'migrations' }),
  ],
};
```

- [ ] **Step 4: Generate the raw catalog with an empty classification document**

Create:

```json
{
  "schema": "contract-evidence-classifications-v1",
  "candidates": {}
}
```

Then run the generator against a clean PostgreSQL database and inspect the complete candidate list. This first raw output is diagnostic only; do not commit it yet.

- [ ] **Step 5: Add only obvious initial classifications**

Classify the high-confidence authorities and projections already documented by current architecture, including at minimum:

```text
work.settle input authority/projections
semantic command descriptor contracts
project-definition discovery/schema contracts
project-horizon public schema contracts
public evidence contracts that map directly to existing SemVer public kinds
generated `lib/` mirrors as automatic projections, not manual entries
```

Leave uncertain historical candidates unclassified rather than guessing. The committed classification document must remain metadata-only.

- [ ] **Step 6: Generate and commit canonical outputs**

Run:

```bash
node scripts/contract-evidence/cli.mjs generate \
  --repo-root . \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog generated/contracts/catalog.json \
  --docs docs/generated/data-contracts.md
```

Run it twice and verify no diff after the second run:

```bash
git diff --exit-code -- generated/contracts/catalog.json docs/generated/data-contracts.md
```

Expected: no diff.

- [ ] **Step 7: Verify SemVer facts without bump judgment**

Add a focused test that mutates a fixture public contract fingerprint and asserts comparison output contains `changed:true` and the declared `semver_kind`, with no `major`, `minor`, `patch`, or recommended-version field.

- [ ] **Step 8: Run the contract suite**

```bash
node --test scripts/contract-evidence/*.test.mjs scripts/contract-evidence/overcenter/*.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/contract-evidence/overcenter/config.mjs scripts/contract-evidence/overcenter/semver-policy.mjs scripts/contract-evidence/overcenter/semver-policy.test.mjs .contract-evidence/classifications.json generated/contracts/catalog.json docs/generated/data-contracts.md
git commit -m "feat: dogfood contract evidence in Overcenter"
```

---

### Task 8: Merge-base ratchet and CI integration

**Files:**
- Create: `scripts/contract-evidence/git-snapshots.mjs`
- Create: `scripts/contract-evidence/git-snapshots.test.mjs`
- Create: `.github/workflows/contract-evidence.yml`
- Create: `scripts/contract-evidence/contract-evidence-workflow.test.mjs`

**Interfaces:**
- Consumes: Task 3 CLI and Task 7 Overcenter config.
- Produces: PR gate that analyzes merge base and head under the candidate compiler, enforces set inclusion, verifies generated outputs, and requires no permanent debt baseline.

- [ ] **Step 1: Write Git snapshot tests**

`git-snapshots.mjs` must expose:

```js
resolveMergeBase({ baseRef, headRef }) -> full 40-char SHA
createDetachedWorktree({ revision, path })
removeWorktree({ path })
```

Use fixture repositories created in a temporary directory. Verify cleanup occurs in `finally` even when catalog generation throws.

- [ ] **Step 2: Write a workflow-structure test before adding YAML**

Read `.github/workflows/contract-evidence.yml` as text and require these properties:

```text
pull_request -> branches: [dev]
actions/checkout@v4 -> fetch-depth: 0
PostgreSQL service image postgres:16
npm ci --prefix scripts/contract-evidence --ignore-scripts
candidate compiler used for both merge-base and head snapshots
compare command after both transient catalogs exist
check command against candidate committed catalog/docs
```

Also assert the workflow does **not** contain strings matching:

```text
baseline
migration_complete
zero_debt_mode
allow_existing_count
```

- [ ] **Step 3: Run workflow test and verify failure**

```bash
node --test scripts/contract-evidence/contract-evidence-workflow.test.mjs
```

Expected: FAIL because the workflow does not exist.

- [ ] **Step 4: Implement the permanent apples-to-apples comparison flow**

The workflow must:

```bash
git fetch --no-tags origin "${{ github.base_ref }}"
BASE_SHA="$(git merge-base HEAD "origin/${{ github.base_ref }}")"
```

Create two detached source worktrees, for example under `$RUNNER_TEMP/contract-base` and `$RUNNER_TEMP/contract-head`.

**Important bootstrap rule:** use the candidate branch's `scripts/contract-evidence/` implementation and Overcenter config to analyze both source snapshots. Pass each snapshot as `--repo-root`. This means the first PR can inspect a merge base that does not yet contain the compiler, and later PRs compare both revisions under exactly one discovery algorithm. Missing `.contract-evidence/classifications.json` in the merge-base snapshot is permanently interpreted as an empty classification set by Task 2.

- [ ] **Step 5: Isolate PostgreSQL state for both revisions**

Create separate temporary databases, for example `contract_base` and `contract_head`, from the PostgreSQL 16 service. Set `PGDATABASE` separately for each generation. Each discoverer applies that revision's migrations to its own clean database before introspection.

Do not run both revisions against the same schema.

- [ ] **Step 6: Generate transient catalogs and enforce set inclusion**

Commands must be equivalent to:

```bash
node scripts/contract-evidence/cli.mjs generate --repo-root "$BASE_ROOT" --config scripts/contract-evidence/overcenter/config.mjs --catalog "$RUNNER_TEMP/base-catalog.json" --docs "$RUNNER_TEMP/base-contracts.md"
node scripts/contract-evidence/cli.mjs generate --repo-root "$HEAD_ROOT" --config scripts/contract-evidence/overcenter/config.mjs --catalog "$RUNNER_TEMP/head-catalog.json" --docs "$RUNNER_TEMP/head-contracts.md"
node scripts/contract-evidence/cli.mjs compare --base-catalog "$RUNNER_TEMP/base-catalog.json" --head-catalog "$RUNNER_TEMP/head-catalog.json"
```

The compare step fails only on new unclassified source identities or invalid catalog relationships, not merely because historical debt still exists.

- [ ] **Step 7: Verify candidate committed generated artifacts**

Run:

```bash
node scripts/contract-evidence/cli.mjs check \
  --repo-root "$HEAD_ROOT" \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog "$GITHUB_WORKSPACE/generated/contracts/catalog.json" \
  --docs "$GITHUB_WORKSPACE/docs/generated/data-contracts.md"
```

The checked-in artifacts must match candidate generation byte-for-byte.

- [ ] **Step 8: Prove self-elimination at zero debt**

The comparison unit test already covers `{ } -> { }` and `{ } -> {A}`. Add one workflow-level fixture whose merge-base catalog has `unclassified_source_identities:[]`; verify the same compare command rejects any candidate with a new unclassified identity. No code path or configuration changes when the set reaches zero.

- [ ] **Step 9: Run all relevant verification**

Run locally with PostgreSQL 16 available:

```bash
node --test scripts/contract-evidence/*.test.mjs scripts/contract-evidence/overcenter/*.test.mjs
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
node --test scripts/dist-runtime-artifact-boundary.test.mjs scripts/verify-semantic-command-descriptors.test.mjs scripts/verify-mcp-admission-contract.test.mjs
```

Then regenerate contract artifacts once more and require:

```bash
git diff --exit-code -- generated/contracts/catalog.json docs/generated/data-contracts.md
```

Expected: all tests PASS and generated artifacts are clean.

- [ ] **Step 10: Commit**

```bash
git add scripts/contract-evidence/git-snapshots.mjs scripts/contract-evidence/git-snapshots.test.mjs scripts/contract-evidence/contract-evidence-workflow.test.mjs .github/workflows/contract-evidence.yml
git commit -m "ci: enforce contract evidence coverage"
```

---

## Final Verification

After all eight tasks are complete, run the full feature verification in a clean checkout with PostgreSQL 16:

```bash
npm ci --prefix scripts/contract-evidence --ignore-scripts
node --test scripts/contract-evidence/*.test.mjs scripts/contract-evidence/overcenter/*.test.mjs
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
node --test scripts/dist-runtime-artifact-boundary.test.mjs scripts/semantic-kernel-provider-boundary.test.mjs scripts/verify-semantic-command-descriptors.test.mjs scripts/verify-mcp-admission-contract.test.mjs scripts/node-postgres-runtime.test.mjs
node scripts/contract-evidence/cli.mjs check --repo-root . --config scripts/contract-evidence/overcenter/config.mjs --catalog generated/contracts/catalog.json --docs docs/generated/data-contracts.md
```

Then inspect `generated/contracts/catalog.json` and confirm:

```text
schema = contract-evidence-catalog-v1
every configured discoverer reports complete
all source identities are unique
all classified projections resolve to one authority
no generated `lib/` mirror is an authority
unclassified identities are explicit and sorted
SemVer kinds come only from the current Overcenter SemVer policy
```

Inspect `docs/generated/data-contracts.md` and confirm the human output is a projection of the catalog, not a second hand-maintained inventory.

Finally, verify the migration property manually from two synthetic catalogs:

```bash
node scripts/contract-evidence/cli.mjs compare --base-catalog /tmp/base-with-debt.json --head-catalog /tmp/head-less-debt.json
node scripts/contract-evidence/cli.mjs compare --base-catalog /tmp/base-zero.json --head-catalog /tmp/head-zero.json
```

Both must pass; `base-zero -> head-new-debt` must fail with `CONTRACT_NEW_UNCLASSIFIED`. There must be no baseline file or zero-debt cleanup code anywhere in the repository.
