# Static Pages publication support

This slice prepares immutable output, acquires prospective provider evidence,
and provides a narrow explicit-lease Git transport. It is **inactive**: it adds no
registered effect, kernel postcondition, observation schema, dispatcher, or
settlement rule. The kernel rejects Pages work before claim. Existing registry
closure tests remain unchanged.

`examples/site/prepare-publication.ts` requires a runtime-admitted source-proof
witness and builds the exact source twice through the existing production
confinement boundary without credentials. A trusted fixture builder is available
for tests; its success does not establish physical confinement. File manifests
bind canonical paths, regular Git modes, exact lengths and SHA-256 hashes, with
finite file, byte, directory-entry and depth budgets.

`src/providers/github/certified-pages.ts` produces a separate `PagesObservation`
type. It does not add that type to the admitted kernel observation union. Reads
require exact repository/ref/settings, provider tree, latest successful build
commit, every served file, and repeated ref/settings fences. Failed, stale,
redirected, oversized, or superseded reads remain uncertain. `.nojekyll` is
verified in the Git tree only.

`src/providers/github/pages-transport.ts` provides `createPagesGitPush`, an
owner-controlled transport dependency for a future reserved adapter. It cannot
authorize work. It uses an isolated bare transport repository, shares only object
storage, disables replacement objects and tag following, binds the HTTPS remote
repository, and uses an explicit refspec and expected-head lease.

Activation is a separate candidate. It must register the effect, validate the
postcondition, reserve before mutation, and independently derive settlement.
The former composed activation grew the shared TCB by 1,190 semantic lines;
that is unresolved until the activation architecture is reduced or lawfully
admitted. Do not deploy through this support slice, invent authority, configure
Pages implicitly, or use generated output as proof of live publication.

See `VALIDATION.md` for candidate checks and remaining rollout evidence.
