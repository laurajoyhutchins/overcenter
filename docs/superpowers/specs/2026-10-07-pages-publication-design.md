# Ordinary GitHub Pages publication

## Intent and baseline

The owner requested that GitHub Pages publication become an ordinary deterministic
capability outside the trusted GitHub-workflow surface. The owner approved the
in-chat design on October 7, 2026. This document specifies that design; it does not
claim that publication is implemented or verified.

Inspected baseline: `8bfc219736006e4159d219c05022e78624934c47`.
PR #659 already provides `examples/site/build.ts` and its projection test.
The build emits static files, including `.nojekyll`, under `.overcenter-build/site`.
The existing effect path separates authorization, reservation, mutation, observation,
and settlement. `src/effect-adapter.ts` is protected by the accepted source profile.

Success means the site can be published through this ordinary path, with evidence
binding the exact admitted output to the provider's build and publicly served bytes.
Deleting the generator must not change authority, admission, or settlement rules.

## Transport decision

Use a dedicated publication branch, initially `refs/heads/gh-pages`, with Pages
configured to serve its root. The destination is owner-configured, never selected
by generated content. Build static output outside Actions and publish it with Git's
receive-pack compare-and-swap, using an explicit expected-head lease.

GitHub's direct Pages deployment API requires a GitHub Actions OIDC token. It would
reintroduce a workflow dependency for this operation. A new publishing workflow and
a website-specific protected-source exception are therefore excluded.

GitHub may internally deploy branch-based Pages through Actions. Those provider
internals are observed as external service behavior; no repository workflow gains
authority to authorize this capability. A branch update alone is not publication.

The initial rollout must test that the configured external credential triggers a
branch build. Do not assume a successful push implies a build. GitHub documents that
pushes using Actions' `GITHUB_TOKEN` do not trigger Pages builds. If the chosen
credential fails the live probe, leave the capability unavailable and report the
specific credential/build gap; do not silently add a deployment workflow.

## Admitted contract

Register `github-pages/publish-static-tree/v1` with
`github-pages-static-tree-published/v1` as its postcondition verifier. Use existing
permits, effect history, reservations, recovery, and settlement interfaces.

An admitted request binds:

- Numeric repository identity and canonical repository name.
- Exact source revision and source tree, with the normal accepted source evidence.
- Destination branch, Pages source root, and canonical HTTPS site origin/base path.
- Expected publication-branch SHA, or an explicit initial-creation expectation.
- Exact publication commit and Git tree, computed before admission.
- A canonical output manifest containing relative paths, byte counts, and SHA-256
  digests; its aggregate digest is part of the admitted identity.
- Explicit file-count and aggregate-byte budgets from the owner-controlled request.

The publication commit uses the expected destination head as its sole parent, or
has no parents for admitted initial creation. Fixed admitted metadata makes its
object identity reproducible; rebuilding must not insert wall-clock timestamps.

The site generator only proposes bytes. A deterministic checker rebuilds from the
pinned source in a separate clean checkout and compares manifests before admission.
Neither that checkout nor generator code receives publication credentials.

Reject absolute paths, traversal, ambiguous normalized names, duplicates, symlinks,
submodules, executable entries, `.git` components, and `.github` content. Require
`index.html` and `.nojekyll`. Reject undeclared files and budget overruns. The
publication tree contains only the admitted static files; it never copies source
code or workflow files into the output branch. No publication receipt is treated
as evidence for source admission, protected recovery, or kernel correctness.

## Execution and authority

The provider adapter validates repository identity and configured Pages destination
before mutation. It derives every coordinate from the admitted postcondition.
It refuses authority refs, the configured source/default branch, and any destination
that differs from the owner-controlled publication destination.

Authorize and durably reserve the effect through the existing kernel before the
remote push. Use an explicit refspec and
`--force-with-lease=<destination>:<expected-sha>`; an explicitly empty expected SHA
is used only for admitted initial creation. Never use an implicit tracking-ref lease
or a forceful REST ref update preceded by a non-atomic GET.

Credentials are injected only into the existing effect execution boundary, never
into generator input, packets, receipts, logs, URLs, or shell command strings.
Invoke transport with argument arrays. Permission access does not itself establish
kernel authority. The implementation must report any broader repository permission
the credential requires instead of claiming branch-scoped credential enforcement.

One-time Pages configuration and credential provisioning are separate operator
actions. The publication adapter may observe settings but cannot rewrite them,
change domains, disable protections, or mint additional credentials.

## Observation and settlement

Extend certified GitHub observation using the repository's pinned provider schema;
reuse certified repository and ref identity reads. Settlement requires all of:

1. Fresh repository and destination-setting identity match.
2. Fresh destination-ref readback equals the admitted publication commit, and its
   tree/file bytes match the admitted manifest.
3. A GitHub Pages build record for that exact commit reports `built`, with no build
   error. An older successful build or an unrelated workflow result is insufficient.
4. Independent HTTPS reads of every admitted publicly served file match its digest.
   The manifest distinguishes served files from deployment metadata: `.nojekyll`
   is the only metadata entry allowed initially and is verified in the Git tree,
   without requiring GitHub to expose it as a public URL.
   Reads use the configured origin/base path and bounded byte limits. Redirects
   outside that coordinate fail closed. Compression is decoded before comparison.
   CDN staleness remains pending/indeterminate, never success.

Observe the ref and settings again after served-byte checks to detect a concurrent
publication/configuration move. These observations prove a bounded observation
window, not permanent availability or atomic deployment of every CDN edge.

Persist the ordinary settlement receipt with source and output identities, the
reservation/attempt identity, provider build identity, observation digests, and
served-file digests. A worker's report or HTTP mutation success cannot settle it.
The observation code fetches and hashes bytes; it does not execute served content.

## Recovery and duplicate delivery

Declare replay and reservation release forbidden initially. Reuse existing
observation-driven recovery; do not add a Pages scheduler or authority store.

After a timeout, observe the admitted ref, build, and served bytes. If all match,
settle the original attempt without another mutation. If the ref matches but the
build or CDN is pending, keep observing with bounded calls. If the ref differs,
the build fails, observations are unavailable, or Pages settings move, preserve the
existing failed/uncertain recovery semantics and never republish automatically.
An absent branch or missing build in a collection is not authoritative absence.

A later publication requires a new admitted request with freshly bound coordinates
and expected head. Reverting served content is another publication, not an implicit
rollback. Duplicate deliveries of an existing reserved request cannot issue a
second push. Historical build success must not settle a publication superseded
before the required current-ref observations.

## Implementation boundary and admission

Add the adapter and certified readback under `src/providers/github/`, the manifest
and isolated site preparation beside `examples/site/`, and hostile tests under
`test/`. Register the effect and postcondition in the existing types, validation,
dispatch, observation, and derived architecture machinery as required by actual
dependency inspection. Do not introduce a parallel kernel or universal deploy API.

Protected registration changes require the accepted owner-authorized recovery
path: exact accepted base, direct-child candidate, exact tree and canonical write
set, checked by the accepted verifier with a durable receipt. No `.github`,
verification-policy, recovery-root, or protected-source exception change is part of
this capability. Split protected and ordinary changes if the accepted recovery
write-set rules require it. Measure and explain any trusted-core growth.

## Required evidence

Hostile tests must cover unauthorized/unreserved dispatch; wrong repository or
destination; protected/default ref targets; stale leases and create races; output
tampering, path tricks, and budgets; mismatched source/tree/manifest identities;
old or failed builds; settings drift; partial/stale served content; off-origin
redirects; bounded reads; duplicate delivery; and crash-after-push recovery with
zero second mutations. Include a real local bare-repository race proving the lease
rejects a competing head, rather than only asserting mocked transport arguments.

Run the accepted lint, typecheck, full unit suite, source-profile/base-test replay,
TCB, code-witness, architecture, and adapter-diagnosability checks applicable to the
changed exact tree. A live owner-configured Pages exercise must publish the admitted
tree, observe its exact build and bytes, and reconstruct settlement after simulated
worker loss. Local fixtures cannot establish live publication support.

## Provider references

- [GitHub Pages publishing sources](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [GitHub Pages REST API](https://docs.github.com/en/rest/pages/pages)

Provider documentation was inspected on October 7, 2026. Before implementation,
recheck the pinned operation schema and live credential/configuration contract.
