# Contract Evidence Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a generic deterministic contract-evidence protocol and dogfood it in Overcenter so every configured structured contract is inventoried, classified, documented, compared across revisions, and prevented from accumulating new unclassified debt.

**Architecture:** Keep the protocol core as repository-verification tooling under `scripts/contract-evidence/`, isolated from the Overcenter application runtime. Generic modules own candidate identity, canonicalization, classification resolution, logical-contract graphs, catalog rendering, revision comparison, and failure semantics. `scripts/contract-evidence/overcenter/` owns Overcenter-specific discovery for TypeScript, manual JavaScript runtime contracts, semantic descriptors, MCP/HTTP boundaries, repo-owned structured data, PostgreSQL, and the existing SemVer policy. CI uses the candidate branch's compiler to analyze both merge-base and candidate source snapshots, so the first rollout needs no committed baseline and every later comparison uses one discovery algorithm.

**Tech Stack:** Node.js 22 ESM, `node:test`, TypeScript compiler API 5.9.2 for TypeScript and JavaScript AST inspection, PostgreSQL 16, `pg` 8.13.1, Git CLI, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-01-contract-evidence-protocol-design.md`

## Global Constraints

- The generic protocol core must not import Overcenter runtime modules, `hatchable`, `lib/`, `src/semantic/`, or `scripts/contract-evidence/overcenter/`.
- Overcenter-specific source knowledge belongs under `scripts/contract-evidence/overcenter/`.
- Do not introduce Zod, TypeBox, JSON Schema generation, or another schema authority.
- Classification metadata stores only source identity, logical identity, significance, projection, and optional compatibility metadata. It must not restate fields, types, allowed values, runtime validation, or database constraints.
- Generated runtime artifacts under `dist/` remain disposable and ignored. The only committed generated contract artifacts in v1 are `generated/contracts/catalog.json` and `docs/generated/data-contracts.md`.
- Historical debt is governed only by `candidate_unclassified ⊆ merge_base_unclassified`. Do not add a baseline file, migration-complete flag, sunset flag, zero-debt mode, count allowance, or cleanup path.
- Compare exact source-identity sets, never counts alone.
- A failed configured discoverer is a hard failure, never an empty result.
- PostgreSQL authority is the final schema after applying all migrations to a clean PostgreSQL 16 database, not migration-file text.
- SemVer integration reports facts such as `semver_kind`, fingerprints, and `changed`; v1 does not decide major/minor/patch.
- The committed catalog must be revision-independent and timestamp-free so an unrelated commit does not churn it.
- Managed repositories do not execute arbitrary discoverer code inside Overcenter. A participating repo runs trusted discoverers for its own technology and emits the shared catalog protocol; Overcenter consumes that evidence.
- V1 proves genericity with a technology-neutral fixture and dogfoods the protocol in Overcenter. V1 does not add remote managed-repository ingestion to the Overcenter runtime.
- Follow the repository's current generated-artifact precedent: regenerate from authoritative source and byte-diff in CI.

## File Structure

Generic protocol files:

- `scripts/contract-evidence/package.json` — isolated tooling dependencies.
- `scripts/contract-evidence/package-lock.json` — locked tooling dependency graph.
- `scripts/contract-evidence/model.mjs` — protocol constants and strict shape validation.
- `scripts/contract-evidence/canonical.mjs` — stable canonical JSON, identities, fingerprints.
- `scripts/contract-evidence/resolver.mjs` — sparse classification and logical-contract resolution.
- `scripts/contract-evidence/catalog.mjs` — deterministic catalog assembly.
- `scripts/contract-evidence/compare.mjs` — set ratchet and structural change facts.
- `scripts/contract-evidence/render-markdown.mjs` — deterministic human projection.
- `scripts/contract-evidence/compiler.mjs` — discoverer orchestration and fail-closed diagnostics.
- `scripts/contract-evidence/cli.mjs` — `generate`, `check`, and `compare` commands.
- `scripts/contract-evidence/git-snapshots.mjs` — merge-base and detached-worktree helpers for CI.

Overcenter adapters:

- `scripts/contract-evidence/overcenter/config.mjs` — repo-specific roots, discoverer list, classification path, SemVer callback.
- `scripts/contract-evidence/overcenter/source-discoverer.mjs` — TypeScript structured exports, manual `lib/**/*.js` structured exports, and generated runtime projections.
- `scripts/contract-evidence/overcenter/semantic-descriptor-discoverer.mjs` — semantic command input-schema candidates.
- `scripts/contract-evidence/overcenter/transport-discoverer.mjs` — MCP and HTTP boundary candidates without executing adapters.
- `scripts/contract-evidence/overcenter/repo-data-discoverer.mjs` — repo-owned structured formats under `.overcenter/`.
- `scripts/contract-evidence/overcenter/postgres-discoverer.mjs` — migration application plus final-schema introspection.
- `scripts/contract-evidence/overcenter/semver-policy.mjs` — AST extraction of allowed compatibility kinds from the existing policy source.

Repository metadata and generated outputs:

- `.contract-evidence/classifications.json`
- `generated/contracts/catalog.json`
- `docs/generated/data-contracts.md`
- `.github/workflows/contract-evidence.yml`

Tests live next to the implementation modules as `*.test.mjs`; fixtures live under `scripts/contract-evidence/fixtures/`.

Do not modify application runtime modules merely to make discovery easier. If a discoverer cannot observe an important existing source without adding duplicate contract declarations, stop and return to design review.

---

### Task 1: Define the generic candidate model, identities, and fingerprints

**Files:**
- Create: `scripts/contract-evidence/package.json`
- Create: `scripts/contract-evidence/package-lock.json`
- Create: `scripts/contract-evidence/model.mjs`
- Create: `scripts/contract-evidence/canonical.mjs`
- Create: `scripts/contract-evidence/model.test.mjs`
- Create: `scripts/contract-evidence/canonical.test.mjs`

**Interfaces:**
- Produces: `CONTRACT_CATALOG_SCHEMA`, `CONTRACT_CLASSIFICATION_SCHEMA`, `SIGNIFICANCE_CLASSES`, `assertCandidate(candidate)`, `assertClassificationDocument(document)`, `sourceIdentity(kind, path, anchor)`, `canonicalJson(value)`, `fingerprintStructure(value)`.
- Consumes: Node.js built-ins only in these two generic runtime modules.

- [ ] **Step 1: Add an isolated tooling package with exact dependencies**

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

Generate the lockfile:

```bash
npm install --prefix scripts/contract-evidence --package-lock-only --ignore-scripts
```

Expected: `package-lock.json` pins `pg@8.13.1` and `typescript@5.9.2`.

- [ ] **Step 2: Write failing model tests**

Create `model.test.mjs` with assertions equivalent to:

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

Also assert that classification entries containing `properties`, `fields`, `allowed_values`, or `validation` fail with `CONTRACT_CLASSIFICATION_SCHEMA_DUPLICATION`.

- [ ] **Step 3: Run the model test and confirm red**

```bash
node --test scripts/contract-evidence/model.test.mjs
```

Expected: FAIL because `model.mjs` does not exist.

- [ ] **Step 4: Implement the strict model**

Use these exact constants:

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

`assertCandidate()` requires every field shown in Step 2. `assertClassificationDocument()` requires `{ schema, candidates }` and validates significance/projection/logical-ID/SemVer metadata without permitting schema-definition keys.

- [ ] **Step 5: Write failing canonicalization tests**

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

- [ ] **Step 6: Implement canonicalization and fingerprints**

`canonicalJson()` recursively sorts object keys and preserves array order. `fingerprintStructure()` hashes canonical UTF-8 bytes with SHA-256 and returns `sha256:<64 lowercase hex>`. `sourceIdentity()` normalizes path separators to `/`, removes leading `./`, rejects `..`, and URI-encodes literal `#` within anchors.

- [ ] **Step 7: Run focused tests**

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

### Task 2: Resolve sparse classifications, automatic generated projections, and logical contracts

**Files:**
- Create: `scripts/contract-evidence/resolver.mjs`
- Create: `scripts/contract-evidence/resolver.test.mjs`
- Create: `scripts/contract-evidence/fixtures/classifications-valid.json`
- Create: `scripts/contract-evidence/fixtures/classifications-invalid.json`

**Interfaces:**
- Consumes: `assertCandidate()`, `assertClassificationDocument()` from Task 1.
- Produces: `loadClassifications(path)`, `resolveLogicalContracts(candidates, classificationDocument, options)`, `unclassifiedSourceIdentities(resolution)`.
- `options.allowedSemverKinds` is a `Set<string>` supplied by repository-specific configuration; the generic resolver does not know Overcenter's SemVer constants.

- [ ] **Step 1: Write authority/projection/unclassified tests**

Use three ordinary candidates:

```js
const candidates = [
  candidate('typescript:src/semantic/work-settle-contract.ts#WorkSettleInput'),
  candidate('mcp:mcp/work.settle.js#inputSchema'),
  candidate('typescript:src/internal.ts#LegacyShape'),
];
```

Use this classification fixture:

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

Assert one authority, one projection, and `LegacyShape` in `unclassified_source_identities`.

- [ ] **Step 2: Write automatic generated-projection tests**

Create a source authority candidate plus a generated JavaScript candidate whose only relationship is:

```js
{
  kind:'generated-projection-of',
  target:'typescript:src/contracts.ts#REQUEST_SCHEMA',
}
```

Classify only the TypeScript authority. Assert the generated candidate is automatically resolved as a projection of the authority and is not counted as unclassified. If the authority itself is unclassified, assert the generated projection remains mechanically recognized as a projection and does not add a second unclassified debt identity.

- [ ] **Step 3: Add failing invariant tests with exact error codes**

Cover:

```text
CONTRACT_DUPLICATE_SOURCE_IDENTITY
CONTRACT_PROJECTION_TARGET_MISSING
CONTRACT_MULTIPLE_AUTHORITIES
CONTRACT_CLASSIFICATION_SOURCE_MISSING
CONTRACT_PROJECTION_SEMVER_OVERRIDE
CONTRACT_SEMVER_KIND_UNKNOWN
CONTRACT_GENERATED_PROJECTION_AMBIGUOUS
```

A manually classified projection cannot set its own `semver_kind`; it inherits from its authority.

- [ ] **Step 4: Run the resolver test and confirm red**

```bash
node --test scripts/contract-evidence/resolver.test.mjs
```

Expected: FAIL because resolver functions are missing.

- [ ] **Step 5: Implement permanent missing-classification-file semantics**

`loadClassifications(path)` returns an empty valid document only when the file does not exist:

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

This is not bootstrap mode. It is the permanent interpretation of “this repository has no classifications”. A later accidental deletion therefore makes previously classified authorities unclassified and fails the normal merge-base set rule.

- [ ] **Step 6: Implement logical resolution**

Rules:

```text
ordinary non-projection classification -> logical_contract required -> authority
manual projection classification       -> projection_of required -> projection
generated-projection-of relationship   -> automatic projection, never authority
unclassified ordinary candidate        -> no logical authority assignment yet
```

Sort candidates, projections, logical contracts, and unclassified source identities lexicographically before returning.

- [ ] **Step 7: Run focused tests**

```bash
node --test scripts/contract-evidence/resolver.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/contract-evidence/resolver.mjs scripts/contract-evidence/resolver.test.mjs scripts/contract-evidence/fixtures/classifications-valid.json scripts/contract-evidence/fixtures/classifications-invalid.json
git commit -m "feat: resolve contract authorities and projections"
```

---

### Task 3: Build the generic compiler, catalog, renderer, comparison, CLI, and isolation proof

**Files:**
- Create: `scripts/contract-evidence/compiler.mjs`
- Create: `scripts/contract-evidence/catalog.mjs`
- Create: `scripts/contract-evidence/render-markdown.mjs`
- Create: `scripts/contract-evidence/compare.mjs`
- Create: `scripts/contract-evidence/cli.mjs`
- Create: `scripts/contract-evidence/compiler.test.mjs`
- Create: `scripts/contract-evidence/compare.test.mjs`
- Create: `scripts/contract-evidence/render-markdown.test.mjs`
- Create: `scripts/contract-evidence/generic-boundary.test.mjs`
- Create: `scripts/contract-evidence/fixtures/generic-repo/contracts.json`
- Create: `scripts/contract-evidence/fixtures/generic-config.mjs`

**Interfaces:**
- Consumes: Task 1 model/canonical functions and Task 2 resolver.
- Produces: `compileCatalog({ repoRoot, discoverers, classificationPath, allowedSemverKinds })`, `renderCatalogMarkdown(catalog)`, `compareUnclassified(baseIds, headIds)`, `compareCatalogs(base, head)`, and CLI commands `generate`, `check`, `compare`.

- [ ] **Step 1: Write fail-closed discoverer tests**

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

Also assert `{ complete:false, candidates:[], diagnostics:[...] }` fails with `CONTRACT_DISCOVERY_INCOMPLETE` instead of being treated as an empty source family.

- [ ] **Step 2: Write deterministic catalog tests**

Two discoverers returning identical candidates in opposite orders must produce byte-identical `canonicalJson(catalog)`.

Require this top-level shape:

```js
{
  schema:'contract-evidence-catalog-v1',
  repository:{ root_marker:'.' },
  generated_by:{ protocol:'contract-evidence-catalog-v1' },
  candidates:[...],
  logical_contracts:[...],
  unclassified_source_identities:[...],
  summary:{ discovered, classified, unclassified, logical_contracts },
}
```

Do not include a commit SHA, absolute path, hostname, random value, or timestamp in the committed catalog.

- [ ] **Step 3: Write exact ratchet tests**

```js
assert.equal(compareUnclassified(['A','B','C'], ['A','C']).ok, true);
assert.deepEqual(compareUnclassified(['A','B','C'], ['A','B','D']).new_unclassified, ['D']);
assert.equal(compareUnclassified([], []).ok, true);
assert.deepEqual(compareUnclassified([], ['A']).new_unclassified, ['A']);
```

`compareCatalogs()` also returns changed logical contracts when authority fingerprints differ:

```js
{
  logical_contract:'work.settle.input',
  semver_kind:'semantic-command-contract',
  base_fingerprint:'sha256:...',
  head_fingerprint:'sha256:...',
  changed:true
}
```

Assert the result contains no major/minor/patch recommendation.

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

Emit `## Unclassified historical debt` only when `unclassified_source_identities.length > 0`.

- [ ] **Step 5: Write the genericity/isolation test**

Recursively inspect generic `scripts/contract-evidence/*.mjs` files, excluding `overcenter/`, `fixtures/`, and tests that intentionally inspect paths. Fail if production modules import or resolve any of:

```text
hatchable
../lib/
../../lib/
src/semantic
./overcenter/
```

Then compile `fixtures/generic-repo` through `fixtures/generic-config.mjs`, whose discoverer reads `contracts.json` and emits one ordinary candidate. Assert the generic compiler succeeds without loading any Overcenter adapter.

- [ ] **Step 6: Run the generic tests and confirm red**

```bash
node --test scripts/contract-evidence/compiler.test.mjs scripts/contract-evidence/compare.test.mjs scripts/contract-evidence/render-markdown.test.mjs scripts/contract-evidence/generic-boundary.test.mjs
```

Expected: FAIL because implementation modules are missing.

- [ ] **Step 7: Implement compiler and catalog assembly**

Every discoverer implements:

```js
{
  name:'example',
  async discover({ repoRoot }) {
    return { complete:true, candidates:[...], diagnostics:[] };
  }
}
```

Run every configured discoverer, validate each result, flatten candidates, load classifications relative to `repoRoot`, and invoke the resolver with `allowedSemverKinds`.

- [ ] **Step 8: Implement the CLI and repository callback boundary**

Config modules may expose:

```js
export default {
  classificationPath:'.contract-evidence/classifications.json',
  discoverers:[...],
  async resolveAllowedSemverKinds({ repoRoot }) {
    return new Set();
  },
};
```

The generic CLI invokes this optional callback and passes the returned `Set<string>` to `compileCatalog()`. The generic compiler does not parse SemVer policy source itself.

Commands:

```text
node scripts/contract-evidence/cli.mjs generate --repo-root <path> --config <config.mjs> --catalog <catalog.json> --docs <data-contracts.md>
node scripts/contract-evidence/cli.mjs check    --repo-root <path> --config <config.mjs> --catalog <catalog.json> --docs <data-contracts.md>
node scripts/contract-evidence/cli.mjs compare  --base-catalog <base.json> --head-catalog <head.json>
```

`check` fails with `CONTRACT_GENERATED_ARTIFACT_STALE` if either committed artifact differs. `compare` fails with `CONTRACT_NEW_UNCLASSIFIED` when set inclusion fails.

- [ ] **Step 9: Run generic tests**

```bash
node --test scripts/contract-evidence/compiler.test.mjs scripts/contract-evidence/compare.test.mjs scripts/contract-evidence/render-markdown.test.mjs scripts/contract-evidence/generic-boundary.test.mjs
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add scripts/contract-evidence/compiler.mjs scripts/contract-evidence/catalog.mjs scripts/contract-evidence/render-markdown.mjs scripts/contract-evidence/compare.mjs scripts/contract-evidence/cli.mjs scripts/contract-evidence/compiler.test.mjs scripts/contract-evidence/compare.test.mjs scripts/contract-evidence/render-markdown.test.mjs scripts/contract-evidence/generic-boundary.test.mjs scripts/contract-evidence/fixtures/generic-repo scripts/contract-evidence/fixtures/generic-config.mjs
git commit -m "feat: compile and compare contract catalogs"
```

---

### Task 4: Discover TypeScript, manual JavaScript, and generated runtime projections

**Files:**
- Create: `scripts/contract-evidence/overcenter/source-discoverer.mjs`
- Create: `scripts/contract-evidence/overcenter/source-discoverer.test.mjs`
- Create: `scripts/contract-evidence/fixtures/source-repo/src/contracts.ts`
- Create: `scripts/contract-evidence/fixtures/source-repo/lib/contracts.js`
- Create: `scripts/contract-evidence/fixtures/source-repo/lib/manual-contracts.js`
- Create: `scripts/contract-evidence/fixtures/source-repo/tsconfig.semantic.runtime.json`

**Interfaces:**
- Consumes: TypeScript compiler API 5.9.2 and Task 1 identity/fingerprint helpers.
- Produces: `createSourceDiscoverer(options)`.

- [ ] **Step 1: Install locked tooling dependencies**

```bash
npm ci --prefix scripts/contract-evidence --ignore-scripts
```

Expected: deterministic install from the Task 1 lockfile.

- [ ] **Step 2: Write TypeScript structured-export tests**

Fixture:

```ts
export interface RequestShape { repo: string; force?: boolean }
export type ResultShape = { ok: boolean; revision: string };
export const REQUEST_SCHEMA = Object.freeze({
  type:'object',
  required:['repo'],
  properties:{ repo:{type:'string'} },
  additionalProperties:false,
} as const);
export const SCALAR = 42;
const LocalOnly = { ignored:true };
```

Expect candidates for `RequestShape`, `ResultShape`, and `REQUEST_SCHEMA`; do not emit `SCALAR` or `LocalOnly`. Normalize AST structure so formatting-only edits do not change fingerprints.

- [ ] **Step 3: Write manual JavaScript structured-export tests**

Fixture `lib/manual-contracts.js`:

```js
export const RUNTIME_REQUEST = Object.freeze({
  required:['repo'],
  properties:{ repo:{type:'string'} },
});
export const RUNTIME_SCALAR = 'not-a-contract';
```

Require a candidate for `javascript:lib/manual-contracts.js#RUNTIME_REQUEST` and no candidate for `RUNTIME_SCALAR`.

This ensures “everything” includes structured contracts still authored directly in runtime JavaScript rather than only the TypeScript island.

- [ ] **Step 4: Write generated runtime projection tests at symbol granularity**

Fixture `tsconfig.semantic.runtime.json` includes `src/contracts.ts`; committed `lib/contracts.js` exports runtime symbol `REQUEST_SCHEMA` but cannot export type-only `RequestShape` or `ResultShape`.

Assert the JavaScript candidate has exactly one observed relationship:

```js
{
  kind:'generated-projection-of',
  target:'typescript:src/contracts.ts#REQUEST_SCHEMA',
}
```

Do not create module-level pseudo-contract identities. Type-only exports simply have no generated runtime projection.

- [ ] **Step 5: Run and confirm red**

```bash
node --test scripts/contract-evidence/overcenter/source-discoverer.test.mjs
```

Expected: FAIL because `source-discoverer.mjs` does not exist.

- [ ] **Step 6: Implement recursive source discovery using the TypeScript parser**

Scan:

```text
src/**/*.ts
lib/**/*.js
```

Exclude tests, `dist/`, `node_modules/`, and generated temporary build roots. Emit exported interfaces, type aliases, enums with structured values, and exported object/array constants. Over-include structured exported shapes and let classification distinguish implementation-only from architectural significance.

- [ ] **Step 7: Implement generated mirror recognition from `tsconfig.semantic.runtime.json`**

Read `rootDir`, `outDir`, and explicit runtime-bearing `include` entries. For a runtime-bearing TypeScript module with a committed corresponding `lib/*.js` compatibility mirror, match same-name runtime structured exports and attach `generated-projection-of` to the TypeScript source symbol.

Any structured JavaScript export not proven to be a generated mirror remains an ordinary candidate and must eventually be classified.

- [ ] **Step 8: Run focused and existing dist-boundary tests**

```bash
node --test scripts/contract-evidence/overcenter/source-discoverer.test.mjs scripts/dist-runtime-artifact-boundary.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/contract-evidence/overcenter/source-discoverer.mjs scripts/contract-evidence/overcenter/source-discoverer.test.mjs scripts/contract-evidence/fixtures/source-repo
git commit -m "feat: discover source contract candidates"
```

---

### Task 5: Discover semantic descriptors, MCP/HTTP boundaries, and repo-owned structured data

**Files:**
- Create: `scripts/contract-evidence/overcenter/semantic-descriptor-discoverer.mjs`
- Create: `scripts/contract-evidence/overcenter/semantic-descriptor-discoverer.test.mjs`
- Create: `scripts/contract-evidence/overcenter/transport-discoverer.mjs`
- Create: `scripts/contract-evidence/overcenter/transport-discoverer.test.mjs`
- Create: `scripts/contract-evidence/overcenter/repo-data-discoverer.mjs`
- Create: `scripts/contract-evidence/overcenter/repo-data-discoverer.test.mjs`
- Create: `scripts/contract-evidence/fixtures/descriptor-repo/descriptor.ts`

**Interfaces:**
- Consumes: TypeScript parser and Task 1 helpers.
- Produces: `createSemanticDescriptorDiscoverer(options)`, `createTransportDiscoverer(options)`, `createRepoDataDiscoverer(options)`.

- [ ] **Step 1: Write a current-code semantic descriptor test for `work.settle`**

Parse `src/semantic/semantic-command-descriptors.ts` statically and require a candidate:

```text
semantic-command:work.settle#input
```

Its normalized structure includes the command, required fields, input schema object, exposure, and surface visible in the descriptor source.

Do **not** assert that current `work.settle` imports its TypeScript `WorkSettleInput` authority. The current descriptor defines its runtime schema locally, so the discoverer must report observed structure without inventing a cross-source authority relationship.

- [ ] **Step 2: Write a synthetic descriptor-reference relationship test**

In `fixtures/descriptor-repo/descriptor.ts`, define a descriptor whose `input_schema` references an imported `REQUEST_SCHEMA`. Assert the discoverer records a source relationship only in this case, where the AST proves the reference.

- [ ] **Step 3: Write MCP projection tests against `mcp/work.settle.js`**

Require:

```text
mcp:mcp/work.settle.js#inputSchema
```

Resolve `inputSchema:WORK_SETTLE_INPUT_SCHEMA` through the import declaration far enough to record the imported symbol/path relationship. Never dynamic-import `mcp/work.settle.js`.

- [ ] **Step 4: Write HTTP boundary tests**

For every `api/**/*.js` module emit one route-level boundary candidate whose normalized structure includes statically visible facts:

```js
{
  path:'api/...',
  access:'public|member|admin|scheduler',
  methods:[...],
  request_paths:[...],
  response_shapes:[...]
}
```

Extract explicit `methods`, `req.body`, `req.query`, and `req.params` property paths, plus object-literal keys passed directly to `res.json(...)`. If a response is an opaque variable/function result, record `{ opaque:true }`. Do not fingerprint full handler source.

- [ ] **Step 5: Write repo-owned data tests**

Require candidates such as:

```text
repo-data:.overcenter/project-definitions.json#project-definition-discovery-v1
repo-data:.overcenter/definitions/target-architecture.json#<document-schema>
```

Use each document's declared `schema` string as anchor when present. Canonicalize parsed JSON, not source whitespace.

- [ ] **Step 6: Run and confirm red**

```bash
node --test scripts/contract-evidence/overcenter/semantic-descriptor-discoverer.test.mjs scripts/contract-evidence/overcenter/transport-discoverer.test.mjs scripts/contract-evidence/overcenter/repo-data-discoverer.test.mjs
```

Expected: FAIL because the discoverers do not exist.

- [ ] **Step 7: Implement all three static discoverers**

Use the TypeScript parser for both `.ts` and `.js`. Never execute MCP/API adapters because they may import Hatchable, bind services, inspect environment state, or mutate runtime state.

Only infer relationships proven by imports, local symbol references, or explicit schema references in the syntax tree.

- [ ] **Step 8: Run focused and existing boundary tests**

```bash
node --test scripts/contract-evidence/overcenter/semantic-descriptor-discoverer.test.mjs scripts/contract-evidence/overcenter/transport-discoverer.test.mjs scripts/contract-evidence/overcenter/repo-data-discoverer.test.mjs scripts/verify-semantic-command-descriptors.test.mjs scripts/verify-mcp-admission-contract.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/contract-evidence/overcenter/semantic-descriptor-discoverer.mjs scripts/contract-evidence/overcenter/semantic-descriptor-discoverer.test.mjs scripts/contract-evidence/overcenter/transport-discoverer.mjs scripts/contract-evidence/overcenter/transport-discoverer.test.mjs scripts/contract-evidence/overcenter/repo-data-discoverer.mjs scripts/contract-evidence/overcenter/repo-data-discoverer.test.mjs scripts/contract-evidence/fixtures/descriptor-repo
git commit -m "feat: discover Overcenter boundary contracts"
```

---

### Task 6: Discover the final PostgreSQL schema from clean migrated databases

**Files:**
- Create: `scripts/contract-evidence/overcenter/postgres-discoverer.mjs`
- Create: `scripts/contract-evidence/overcenter/postgres-discoverer.test.mjs`
- Create: `scripts/contract-evidence/fixtures/postgres/migrations/001_create_example.sql`
- Create: `scripts/contract-evidence/fixtures/postgres/migrations/002_alter_example.sql`

**Interfaces:**
- Consumes: `pg@8.13.1`, PostgreSQL 16 connection environment, migration directory path.
- Produces: `applyMigrations(client, migrationsDir)`, `introspectPostgresContracts(client)`, `createPostgresDiscoverer(options)`.

- [ ] **Step 1: Write a migration-authority test**

`001_create_example.sql`:

```sql
CREATE TABLE example_contract (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  obsolete text
);
```

`002_alter_example.sql`:

```sql
ALTER TABLE example_contract DROP COLUMN obsolete;
```

Assert final discovery contains `id` and `payload` but no `obsolete`. This proves final migrated state is authority.

- [ ] **Step 2: Write deterministic introspection tests**

Require candidates for tables, columns, enum/domain types, check/foreign-key/unique constraints, and views when present. Every SQL query used for discovery must have explicit stable ordering.

JSONB without a linked richer contract is represented only by facts such as:

```js
{ data_type:'jsonb', nullable:false }
```

Do not infer inner fields from sample data or SQL usage.

- [ ] **Step 3: Create a clean test database and confirm red**

Example local setup:

```bash
createdb -h 127.0.0.1 -U overcenter contract_evidence_test
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=contract_evidence_test PGUSER=overcenter PGPASSWORD=overcenter \
  node --test scripts/contract-evidence/overcenter/postgres-discoverer.test.mjs
```

Expected: FAIL because the discoverer does not exist. Drop/recreate `contract_evidence_test` before reruns that need a pristine database.

- [ ] **Step 4: Implement migration application**

Read `migrations/*.sql` lexicographically and execute one migration file at a time against the caller-supplied clean database. Fail on SQL error with `CONTRACT_DATABASE_MIGRATION_FAILED` and the migration path.

Do not rely on Hatchable's migration ledger.

- [ ] **Step 5: Implement final-schema introspection**

Read from `pg_catalog` / `information_schema`, excluding system schemas and tooling schemas. Stable identities include:

```text
postgres:public.orchestration_runs#table
postgres:public.orchestration_runs#status
postgres:public.some_enum#type
postgres:public.some_view#view
```

- [ ] **Step 6: Run PostgreSQL tests in clean databases**

```bash
dropdb -h 127.0.0.1 -U overcenter --if-exists contract_evidence_test
createdb -h 127.0.0.1 -U overcenter contract_evidence_test
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=contract_evidence_test PGUSER=overcenter PGPASSWORD=overcenter \
  node --test scripts/contract-evidence/overcenter/postgres-discoverer.test.mjs
```

Then run the existing portable runtime test in its own database rather than reusing `contract_evidence_test`.

- [ ] **Step 7: Commit**

```bash
git add scripts/contract-evidence/overcenter/postgres-discoverer.mjs scripts/contract-evidence/overcenter/postgres-discoverer.test.mjs scripts/contract-evidence/fixtures/postgres
git commit -m "feat: discover migrated PostgreSQL contracts"
```

---

### Task 7: Wire Overcenter configuration, SemVer policy facts, classifications, and generated outputs

**Files:**
- Create: `scripts/contract-evidence/overcenter/config.mjs`
- Create: `scripts/contract-evidence/overcenter/semver-policy.mjs`
- Create: `scripts/contract-evidence/overcenter/semver-policy.test.mjs`
- Create: `.contract-evidence/classifications.json`
- Create: `generated/contracts/catalog.json`
- Create: `docs/generated/data-contracts.md`

**Interfaces:**
- Consumes: all Tasks 4-6 discoverers and `src/semantic/semver-public-api.ts`.
- Produces: an Overcenter config compatible with the generic callback interface plus the first canonical catalog/docs.

- [ ] **Step 1: Write SemVer policy extraction tests**

Parse `src/semantic/semver-public-api.ts` and require the existing public kinds:

```text
semantic-command
semantic-command-contract
project-definition-schema
project-horizon-schema
public-evidence-schema
external-error-semantics
lifecycle-semantics
```

Also require the internal implementation kinds from the same source. The contract-evidence code must not duplicate the lists as its own authority.

- [ ] **Step 2: Implement `readOvercenterSemverKinds(sourcePath)` with the TypeScript AST**

Find `SEMVER_PUBLIC_API_KINDS` and `SEMVER_INTERNAL_IMPLEMENTATION_KINDS`, extract their literal strings, and return one `Set<string>`. Fail with `CONTRACT_SEMVER_POLICY_UNREADABLE` if either constant is missing or non-literal.

- [ ] **Step 3: Create the Overcenter config using the generic callback**

`config.mjs` exports:

```js
export default {
  classificationPath:'.contract-evidence/classifications.json',
  discoverers:[
    createSourceDiscoverer({
      typescriptRoot:'src',
      javascriptRoot:'lib',
      runtimeTsconfig:'tsconfig.semantic.runtime.json',
    }),
    createSemanticDescriptorDiscoverer({ source:'src/semantic/semantic-command-descriptors.ts' }),
    createTransportDiscoverer({ mcpRoot:'mcp', apiRoot:'api' }),
    createRepoDataDiscoverer({ roots:['.overcenter/project-definitions.json', '.overcenter/definitions'] }),
    createPostgresDiscoverer({ migrationsRoot:'migrations' }),
  ],
  async resolveAllowedSemverKinds({ repoRoot }) {
    return readOvercenterSemverKinds(join(repoRoot, 'src/semantic/semver-public-api.ts'));
  },
};
```

- [ ] **Step 4: Generate a raw catalog from a dedicated clean database**

Create an empty classification document:

```json
{
  "schema": "contract-evidence-classifications-v1",
  "candidates": {}
}
```

Prepare a clean database:

```bash
dropdb -h 127.0.0.1 -U overcenter --if-exists contract_evidence_local
createdb -h 127.0.0.1 -U overcenter contract_evidence_local
```

Generate to temporary files with `PGDATABASE=contract_evidence_local` and inspect the candidate list. Do not commit this raw output.

- [ ] **Step 5: Add only high-confidence classifications**

Classify architectural facts already established by current Overcenter design and source, including high-confidence semantic command contracts, project-definition/project-horizon public contracts, public evidence contracts with direct existing SemVer kinds, manual boundary/internal contracts where significance is mechanically obvious, and manually authored JavaScript contracts that are clearly implementation-only.

Generated `lib/` compatibility mirrors proven by Task 4 are automatic projections and receive no manual classification entry.

Leave uncertain historical candidates unclassified rather than guessing.

- [ ] **Step 6: Generate canonical outputs twice from clean database state**

Because the PostgreSQL discoverer applies migrations, recreate the database before each full generation:

```bash
dropdb -h 127.0.0.1 -U overcenter --if-exists contract_evidence_local
createdb -h 127.0.0.1 -U overcenter contract_evidence_local
PGDATABASE=contract_evidence_local node scripts/contract-evidence/cli.mjs generate \
  --repo-root . \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog generated/contracts/catalog.json \
  --docs docs/generated/data-contracts.md
```

Save copies of both outputs, recreate the database, generate again, and require byte equality. Then require:

```bash
git diff --exit-code -- generated/contracts/catalog.json docs/generated/data-contracts.md
```

after a third `check` run against equivalent clean state.

- [ ] **Step 7: Verify SemVer change facts only**

Use fixture catalogs with one changed public authority. Assert `compareCatalogs()` emits `changed:true` plus the authority's `semver_kind`, and does not emit `major`, `minor`, `patch`, `recommended_version`, or equivalent judgment.

- [ ] **Step 8: Run the feature suite**

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

### Task 8: Enforce merge-base set ratcheting and generated-artifact freshness in CI

**Files:**
- Create: `scripts/contract-evidence/git-snapshots.mjs`
- Create: `scripts/contract-evidence/git-snapshots.test.mjs`
- Create: `scripts/contract-evidence/contract-evidence-workflow.test.mjs`
- Create: `.github/workflows/contract-evidence.yml`

**Interfaces:**
- Consumes: Task 3 CLI and Task 7 Overcenter config.
- Produces: PR gate that analyzes merge-base and candidate snapshots under one compiler, uses isolated databases, enforces exact-set inclusion, and verifies committed generated output.

- [ ] **Step 1: Write Git snapshot tests**

Expose:

```js
resolveMergeBase({ baseRef, headRef }) -> full 40-character SHA
createDetachedWorktree({ revision, path })
removeWorktree({ path })
```

Use temporary fixture repositories. Assert cleanup occurs in `finally` after injected catalog-generation failure.

- [ ] **Step 2: Write workflow-structure tests before adding YAML**

Read `.github/workflows/contract-evidence.yml` and require:

```text
pull_request -> branches: [dev]
actions/checkout@v4 with fetch-depth: 0
PostgreSQL service image postgres:16
npm ci --prefix scripts/contract-evidence --ignore-scripts
candidate compiler used to analyze both merge-base and candidate source roots
separate base and head databases
compare after both transient catalogs exist
check against candidate committed catalog/docs
```

Reject workflow text containing case-insensitive migration scaffolding tokens:

```text
baseline
migration_complete
zero_debt_mode
allow_existing_count
```

The word `merge-base` is valid and must not trigger the `baseline` check.

- [ ] **Step 3: Run workflow test and confirm red**

```bash
node --test scripts/contract-evidence/contract-evidence-workflow.test.mjs
```

Expected: FAIL because the workflow does not exist.

- [ ] **Step 4: Implement permanent apples-to-apples source comparison**

Checkout full history and resolve:

```bash
git fetch --no-tags origin "${{ github.base_ref }}"
BASE_SHA="$(git merge-base HEAD "origin/${{ github.base_ref }}")"
```

Create detached source worktrees under `$RUNNER_TEMP/contract-base` and `$RUNNER_TEMP/contract-head`.

Use the **candidate branch's** `scripts/contract-evidence/cli.mjs` and `scripts/contract-evidence/overcenter/config.mjs` to analyze both `--repo-root` snapshots. Do not execute compiler code from the merge-base worktree. This lets the first protocol PR analyze a merge base that does not yet contain the compiler and ensures every later PR uses one discovery algorithm for both revisions.

A missing `.contract-evidence/classifications.json` in an old snapshot is permanently interpreted as empty classifications by Task 2.

- [ ] **Step 5: Create separate clean PostgreSQL databases for base and head**

Create:

```text
contract_base
contract_head
```

Run merge-base generation with `PGDATABASE=contract_base` and candidate generation with `PGDATABASE=contract_head`. Each starts empty and receives only that snapshot's migrations.

- [ ] **Step 6: Generate transient catalogs and enforce the exact set invariant**

Equivalent commands:

```bash
PGDATABASE=contract_base node scripts/contract-evidence/cli.mjs generate \
  --repo-root "$BASE_ROOT" \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog "$RUNNER_TEMP/base-catalog.json" \
  --docs "$RUNNER_TEMP/base-contracts.md"

PGDATABASE=contract_head node scripts/contract-evidence/cli.mjs generate \
  --repo-root "$HEAD_ROOT" \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog "$RUNNER_TEMP/head-catalog.json" \
  --docs "$RUNNER_TEMP/head-contracts.md"

node scripts/contract-evidence/cli.mjs compare \
  --base-catalog "$RUNNER_TEMP/base-catalog.json" \
  --head-catalog "$RUNNER_TEMP/head-catalog.json"
```

Historical debt may remain. The compare step fails only when `head.unclassified` contains an identity absent from `base.unclassified` or when catalog invariants are invalid.

- [ ] **Step 7: Verify candidate committed generated artifacts in another clean head database**

Drop/recreate `contract_head_check`, then run:

```bash
PGDATABASE=contract_head_check node scripts/contract-evidence/cli.mjs check \
  --repo-root "$HEAD_ROOT" \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog "$GITHUB_WORKSPACE/generated/contracts/catalog.json" \
  --docs "$GITHUB_WORKSPACE/docs/generated/data-contracts.md"
```

- [ ] **Step 8: Prove zero-debt self-elimination**

At unit level, retain these permanent cases:

```text
{} -> {}      passes
{} -> {A}     fails with CONTRACT_NEW_UNCLASSIFIED
{A,B} -> {A} passes
{A,B} -> {A,C} fails because C is new
```

At workflow level, use fixture catalogs to prove the same `compare` command handles zero debt without a flag or alternate branch.

- [ ] **Step 9: Run all relevant verification**

With PostgreSQL 16 available and clean feature databases:

```bash
npm ci --prefix scripts/contract-evidence --ignore-scripts
node --test scripts/contract-evidence/*.test.mjs scripts/contract-evidence/overcenter/*.test.mjs
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
node --test scripts/dist-runtime-artifact-boundary.test.mjs scripts/verify-semantic-command-descriptors.test.mjs scripts/verify-mcp-admission-contract.test.mjs
```

Recreate a clean `contract_evidence_verify` database and run:

```bash
PGDATABASE=contract_evidence_verify node scripts/contract-evidence/cli.mjs check \
  --repo-root . \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog generated/contracts/catalog.json \
  --docs docs/generated/data-contracts.md
```

Expected: all tests PASS and generated artifacts match.

- [ ] **Step 10: Commit**

```bash
git add scripts/contract-evidence/git-snapshots.mjs scripts/contract-evidence/git-snapshots.test.mjs scripts/contract-evidence/contract-evidence-workflow.test.mjs .github/workflows/contract-evidence.yml
git commit -m "ci: enforce contract evidence coverage"
```

---

## Final Verification

After all eight tasks are complete, verify from a clean checkout with PostgreSQL 16:

```bash
npm ci --prefix scripts/contract-evidence --ignore-scripts
node --test scripts/contract-evidence/*.test.mjs scripts/contract-evidence/overcenter/*.test.mjs
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
node --test scripts/dist-runtime-artifact-boundary.test.mjs scripts/semantic-kernel-provider-boundary.test.mjs scripts/verify-semantic-command-descriptors.test.mjs scripts/verify-mcp-admission-contract.test.mjs
```

Create a fresh catalog-verification database:

```bash
dropdb -h 127.0.0.1 -U overcenter --if-exists contract_evidence_verify
createdb -h 127.0.0.1 -U overcenter contract_evidence_verify
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=contract_evidence_verify PGUSER=overcenter PGPASSWORD=overcenter \
  node scripts/contract-evidence/cli.mjs check \
    --repo-root . \
    --config scripts/contract-evidence/overcenter/config.mjs \
    --catalog generated/contracts/catalog.json \
    --docs docs/generated/data-contracts.md
```

Inspect `generated/contracts/catalog.json` and confirm:

```text
schema = contract-evidence-catalog-v1
every configured discoverer completed successfully
all ordinary source identities are unique
all classified projections resolve to one authority
all proven generated `lib/` mirrors are automatic projections, never authorities
manual structured `lib/*.js` exports remain represented unless proven generated
unclassified ordinary identities are explicit and sorted
SemVer kinds are accepted only through the repository callback and current policy source
no revision/timestamp/host-specific field makes committed output churn
```

Inspect `docs/generated/data-contracts.md` and confirm it is a deterministic projection of the catalog rather than a second hand-maintained inventory.

Run synthetic comparison fixtures and require:

```text
base {A,B,C} -> head {A,C}   PASS
base {A,B,C} -> head {A,B,D} FAIL with new_unclassified = [D]
base {}      -> head {}      PASS
base {}      -> head {A}     FAIL with CONTRACT_NEW_UNCLASSIFIED
```

Finally search the implementation and workflow for migration scaffolding. There must be no committed unclassified baseline, migration-complete bit, zero-debt mode, count allowance, or cleanup code. When the merge-base set reaches zero, the unchanged set-inclusion invariant must be the only mechanism enforcing permanent zero debt.
