# GitHub Pages Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development if the owner selects delegated execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish an admitted static tree through ordinary reserved effects, with independent evidence of the exact Pages build and served bytes.

**Architecture:** Prepare immutable static output without credentials, push a dedicated branch with an explicit expected-head Git lease, and settle from certified provider and HTTPS readback. Existing kernel authority, reservation, recovery, and settlement remain authoritative. Provider support lands before a minimal protected capability registration.

**Tech Stack:** TypeScript, Node built-ins, Git receive-pack, pinned GitHub REST observation contracts, existing TypeBox observation schema; zero new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-pages-publication-design.md`

## Global Constraints

- Effect: `github-pages/publish-static-tree/v1`; verifier: `github-pages-static-tree-published/v1`.
- Initial publication destination: `refs/heads/gh-pages`, Pages source root `/`.
- Replay and reservation release are forbidden initially; collection absence is never authoritative.
- `.nojekyll` is the only deployment metadata entry; all other admitted files require served-byte checks.
- No `.github`, verification-policy, recovery-root, or protected-source exception changes.
- Source generator receives no publication credentials; provider adapter cannot modify Pages settings.
- Fixed admitted commit metadata; no build timestamps; exact manifest paths, byte sizes, and SHA-256 digests.
- Owner-controlled file-count, byte, and observation-call budgets; no implicit unlimited traversal.
- Protected changes use exact-base, direct-child, exact-tree recovery and the accepted verifier.
- No generated observation schema edits by hand; no TCB exclusions or baseline increases to disguise growth.

## Review Focus

- Case-folding and URL-encoding collisions must not publish two files to one effective URL (Task 1).
- A stale checkout/tracking ref must not weaken an explicit expected-head lease (Task 3).
- CDN compression, query behavior, and redirects must not change the meaning of byte verification (Task 2).
- A Pages domain or source setting changed during observation must prevent settlement (Task 2).
- An unrelated active publication must not authorize recovery or overwrite a newer destination (Task 5).

## File and interface map

Create `src/providers/github/pages-contract.ts`: pure publication types and validators.
Create `examples/site/prepare-publication.ts`: isolated source build and immutable Git objects.
Create `src/providers/github/certified-pages.ts`: bounded certified build and served-byte observations.
Create `src/providers/github/pages-effect.ts`: reserved Git publication, accepting branded authority.
Create focused `test/pages-*.test.ts` files alongside existing provider tests.

Modify `src/providers/github/semantics.ts` and regenerate `operations.generated.ts` for
Pages settings/build reads. Modify `src/model.ts`, `schema/settlement-observation.typebox.ts`,
its generated projection, `src/observation/observe.ts`, and `src/semantics.ts` for the
postcondition, coordinate checking, evidence verification, and conflict identity.
Only activation modifies protected `src/effect-adapter.ts` and
`src/providers/effect-dispatch.ts`. Architecture SQL changes, if required by derived
analysis, belong to that protected transition; recovery-root files are excluded.

`PagesManifestEntry` has `path: string`, `bytes: number`, `sha256: string`, and
`delivery: 'served' | 'metadata'`. `PagesManifest` has ordered `files`,
`file_count`, `total_bytes`, and `sha256` (digest of the canonical manifest excluding
its own digest). Reject unsorted/noncanonical input rather than silently repairing it.

`PagesPublication` has `provider: 'github'`, `repository_id`,
`repository_full_name`, `source_sha`, `source_tree_sha`, `source_ref`,
`destination_ref`, `expected_head_sha: string | null`, `publication_sha`,
`publication_tree_sha`, `site_base_url`, `pages_source_path: '/'`, `manifest`,
and `limits: { max_files; max_total_bytes; max_observation_calls }`.
SHA fields are canonical lowercase hex; `null` means admitted initial creation.
`GitHubPagesPublicationPostcondition` extends it with the exact verifier literal.

`PagesPublicationAuthority` is
`EffectAuthority<'github-pages/publish-static-tree/v1', 'github-pages-static-tree-published/v1'>`.
The adapter accepts this brand; it cannot construct it. Registration in Task 4 is the
only production caller that obtains that typed authority from an execution permit.

## Task 1: Prepare immutable static output

**Files:** Create `pages-contract.ts`, `prepare-publication.ts`,
`test/pages-publication-manifest.test.ts`, `test/pages-publication-preparation.test.ts`.

**Interfaces:** Produce `validatePagesPublication(value: unknown): asserts value is PagesPublication`,
`manifestStaticTree(root: string, limits: PagesPublication['limits']): Promise<PagesManifest>`,
and `prepareSitePublication(input: PagesPreparationInput): Promise<PagesPublication>`.
Define `PagesPreparationInput` as publication coordinates/limits plus `source_repo`,
`scratch_root`, an accepted source-verification evidence reference, and fixed
`commit_metadata: { author_name; author_email; timestamp }`. Verify that reference
through the existing source-evidence admission functions; a worker-supplied SHA or
success flag is insufficient. The prepared publication is proposed to the existing
operator/project admission interface, not installed directly into authority.

- [ ] Write tests named `manifest rejects path and URL collisions`, `manifest rejects nonregular files and budgets`, and `preparation binds reproducible source and output`. Assert failures for `../x`, `/x`, backslashes, `.git`, `.github`, symlinks, executable Git modes, case-folded/percent-encoded collisions, missing `index.html`/`.nojekyll`, and one byte/file over the supplied budget. Assert two preparations with identical inputs produce identical manifests, trees, and commit SHAs; source or CSS movement changes identity.
- [ ] Run `node --experimental-strip-types --test test/pages-publication-manifest.test.ts test/pages-publication-preparation.test.ts`; expect a missing-module/export failure before implementation.
- [ ] Implement the pure validator and manifest collector. Reject URL-sensitive filenames rather than inventing URL normalization rules; allow nested static paths with a documented conservative ASCII segment grammar. Only `.nojekyll` has `delivery: 'metadata'`.
- [ ] Implement preparation using clean pinned-source checkouts and the existing `buildSite`. Rebuild in a second clean checkout and compare manifests; materialize regular blobs/tree/commit from checked bytes with the exact parent and fixed metadata. Launch the existing confined worker executor for generator execution without credentials or provider network access; avoid shell command strings. Reject input source-tree disagreement before running it.
- [ ] Rerun the focused tests; expect all tests pass, including no credential/environment leakage into the generator fixture.
- [ ] Commit as `Add deterministic static publication preparation` on an ordinary support branch. Include no capability registration or remote mutation.

## Task 2: Certified Pages observation and postcondition semantics

**Files:** Create `certified-pages.ts`, `test/pages-publication-observation.test.ts`;
modify provider `semantics.ts`, generated operations, `src/model.ts`,
`src/semantics.ts`, `src/observation/observe.ts`, observation TypeBox/generated schema.

**Interfaces:** Consume Task 1's `PagesPublication`. Produce
`observeCertifiedGitHubPagesPublication(p: GitHubPagesPublicationPostcondition, context: PagesObservationContext): Promise<Observation>`
and `githubPagesPublicationEvidenceMatches(p: GitHubPagesPublicationPostcondition, observed: Observation): boolean`.
`PagesObservationContext` contains injected `token`, `get: GitHubJsonGetAsync`,
`readServedFile(url: string, maxDecodedBytes: number): Promise<Uint8Array>`,
`readGitTree(publication: PagesPublication): Promise<PagesManifest>`, and `clock`.
The default implementations acquire provider data; injected functions are trusted
observer dependencies, never packet-supplied code.

- [ ] Write observation tests for `exact build and all served bytes verify`, `old build cannot verify`, `settings and ref movement prevent settlement`, and `served reads stay bounded and on coordinate`. Assert `built` for another SHA, failed builds, forged observation coordinates, tree mismatch, a missing/mismatched served file, cross-origin/base-path redirects, oversized decoded bodies, exhausted call budget, and settings/ref movement all fail verification. `.nojekyll` needs a Git-tree check but no HTTP request; gzip decoding preserves the expected hash.
- [ ] Run `node --experimental-strip-types --test test/pages-publication-observation.test.ts`; expect failure before adding the observer.
- [ ] Add Pages settings and build reads to the existing provider semantic operation declarations. Use the pinned OpenAPI digest/source commit from `contract.ts` with `scripts/generate-github-operations.ts`; do not update the schema pin opportunistically. Select exact build commit/status/error fields and bounded pagination. Treat 404, empty collections, and exhausted scans as indeterminate.
- [ ] Add the postcondition and schema verifier literal; run `npm run generate:settlement-observation`. Implement strict coordinate/evidence matching, no accepted absence kinds, and noncommuting resource identity `github-pages:<repository_id>:<destination_ref>`. The desired identity binds the entire publication. Sync observation reports indeterminate for this asynchronous provider instead of blocking or pretending success; async observation uses the new certified reader.
- [ ] Add optional trusted `pages` dependencies to the existing `ObservationContext`, using `PagesObservationContext` from this task. Preserve ordinary receipt serialization through `provider_evidence`; observation coordinate assertions bind the complete publication digest and repository/ref before accepting it.
- [ ] Implement the bounded observation sequence: repository/settings/ref, immutable tree, exact build, all served files, then settings/ref again. Use manual redirect handling, configured HTTPS origin/base path, bounded streaming, and cache-aware retries on later observation attempts. Store normalized evidence inside `provider_evidence`; verify bindings again in `observationVerified`, rather than trusting a boolean in the envelope.
- [ ] Run focused tests, `npm run check:settlement-observation`, `npm run test:github-contract`, and `npm run typecheck`; expect success and byte-identical regenerated operations.
- [ ] Commit as `Observe exact Pages publications without mutation authority`. The capability remains unregistered.

## Task 3: Reserved publication transport, without activation

**Files:** Create `pages-effect.ts`, `test/pages-publication-transport.test.ts`.

**Interfaces:** Consume `PagesPublicationAuthority` and `PagesPublication`.
Produce `performGitHubPagesPublicationEffect(kernel: KernelCore, authority: PagesPublicationAuthority, context: PagesEffectContext): Promise<Data>`.
`PagesEffectContext` contains an owner-configured `destination`, observer dependencies,
local object repository, and credential-injected Git transport. Define
`pushWithExpectedHead(request: { destination_ref; expected_head_sha; publication_sha }): Promise<void>`
as the narrow transport interface; no arbitrary refspec/argv is accepted from work packets.

- [ ] Write `explicit Git lease rejects a competing head` using a real temporary bare repository. Read head A, move remote to B, and assert pushing C with expected A is rejected and B survives. Also cover admitted initial creation racing another create, and stale tracking refs while the explicit lease remains A.
- [ ] Write adapter tests for forged/unreserved authority, destination/default/source/authority ref rejection, immutable-tree tampering before push, missing token, and nonmatching Pages settings. Assert zero transport calls for every rejected input. Test transport success returns mutation data without claiming settlement.
- [ ] Run `node --experimental-strip-types --test test/pages-publication-transport.test.ts`; expect failure before implementing the adapter.
- [ ] Implement `kernel.performEffect(authority, ...)` around the push. Verify the admitted local object tree/manifest immediately before pushing; use explicit `--force-with-lease=<ref>:<expected>` and an explicit refspec. Keep credentials out of argv, packets, receipts, and errors. Do not synthesize a branded authority or call the generic authorization overload to bypass registration.
- [ ] Rerun transport tests; expect the real receive-pack race and zero-mutation rejection assertions to pass. Positive permit/reservation integration is deferred to Task 5 because registration is not active yet.
- [ ] Commit as `Add reserved Pages publication transport`. Review all support tasks together and run accepted checks before admitting ordinary support.

## Task 4: Minimal protected activation

**Files:** Modify protected `src/effect-adapter.ts`, `src/providers/effect-dispatch.ts`;
modify protected `architecture/physics.sql`/`logic.sql` only if existing derived
reconciliation requires explicit capability facts. No other protected files.

**Interfaces:** Register the effect/verifier literals from Task 1. Extend the existing
dispatch context with `pages: PagesEffectContext`, authorize using the registered
constant, and invoke Task 3's branded adapter.

- [ ] Prepare the Task 5 kernel tests on a separate ordinary test branch and run a temporary composed activation+test tree. Expect the unactivated support tree to reject dispatch, and the composed tree to pass positive and hostile cases. Do not call that composed-tree result exact-head admission evidence.
- [ ] Implement one capabilities entry: duplicate delivery `may-duplicate`, replay `forbidden`, reservation release `forbidden`; uncertainty reconciles before any new request. Add the dispatch case and required derived architecture facts only.
- [ ] Run accepted lint, typecheck, full unit suite, TCB, code witnesses, architecture reconciliation, source-profile/base-test replay, and adapter diagnosability. Record the actual trusted-core delta. If the ratchet rejects growth, reduce/reuse machinery or report the exact rejection; do not add exclusions or raise the limit.
- [ ] Recut the activation as one direct child of the current accepted main after support lands. Compute exact candidate SHA/tree and canonical protected write set. Run the accepted recovery verifier on that candidate; expect all structural and executable checks to pass using the accepted base verifier.
- [ ] Commit as `Register ordinary Pages publication capability`. Use owner-authorized protected recovery to admit the exact candidate and retain its durable receipt. If main moves, recut and reverify; never reuse stale authorization.

## Task 5: Kernel recovery integration and live publication evidence

**Files:** Create `test/pages-publication-kernel.test.ts`,
`experiments/pages-publication/experiment.ts`, and its `README.md`; update
`docs/provider-capabilities.md`. Test/experiment/docs changes use ordinary admission.

**Interfaces:** Exercise the registered dispatch, `OvercenterKernel` claim/permit,
reservation, observation, recovery, and settlement APIs. The live experiment accepts
explicit owner-provided repository/destination/limits and external credentials,
and writes the resulting ordinary receipt/evidence without inventing authority.

- [ ] Write kernel tests for `reserved publication settles exact independent readback`, `crash after push recovers without a second mutation`, `duplicate delivery issues one push`, and `superseded publication remains unsettled`. Assert total push count is one across reconstruction; pending CDN/build observations do not become DONE; unrelated reservation identity, forged receipts, and a competing publication cannot settle or authorize another push. Registration/effect-verifier mismatch fails closed.
- [ ] Run `node --experimental-strip-types --test test/pages-publication-kernel.test.ts`; expect success only with the admitted registration. Run the complete ordinary test candidate and accepted exact-head checks before landing these tests. Do not enable operational use until this stage passes.
- [ ] Implement the bounded live experiment and document its exact CLI. Require confirmed branch-root Pages configuration, external credential behavior, and an admitted source/output identity before any push. Existing operator commands create/claim the work; the experiment does not bypass them or configure Pages implicitly.
- [ ] Run the real publication, simulate worker loss after the reserved push, then reconstruct observation/settlement in a fresh process. Expect the exact build SHA and every served digest to match, with zero second pushes. Report a credential/configuration/build gap precisely if the live probe cannot complete; fixture success is not live support.
- [ ] Update provider capability documentation with observation, mutation, absence, and settlement support separately. Record exact source/candidate/output identities, evidence digests, checks, recovery receipt, and live publication receipt in the experiment result.
- [ ] Commit as `Verify Pages publication recovery and provider evidence`. Report the final exact head and any remaining live-evidence gap; claim publication complete only after the real provider readback succeeds.

## Handoff

The owner approved the design and spec. This plan still requires review and an
execution-method choice. Native execution is recommended because all five tasks
share the publication contract and the protected transition is sequential.
