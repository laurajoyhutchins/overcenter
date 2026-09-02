# GitHub branch policy v1

`github.branch_policy.reconcile` is the narrow administration surface for converging a repository default branch on the Portfolio branch policy.

Input is exactly `repo`, `expected_head`, and `required_checks` (plus optional orchestration `run_id` in MCP). The expected head is the current default-branch SHA and is used both as a concurrency fence and as the authority for resolving exact GitHub check-run identities.

The managed repository policy is:

- squash merge enabled; merge commits and rebase merges disabled;
- squash title from the PR title and blank squash body;
- automatic deletion of merged head branches enabled;
- auto-merge disabled;
- one active Portfolio-owned ruleset targeting `~DEFAULT_BRANCH`;
- default-branch deletion and non-fast-forward updates rejected;
- pull requests required with zero mandatory human approvals and resolved review threads;
- squash is the only allowed PR merge method;
- linear history required;
- caller-selected required checks enforced in strict mode when the set is non-empty;
- an empty required-check set is valid for a repository that does not yet have CI, and emits no `required_status_checks` rule;
- no bypass actors.

The command recognizes the older `Exact-head review clearance` and `Hatchable required checks: ...` rulesets as migration predecessors. It will not overwrite classic branch protection or layer over an unowned ruleset that contributes effective policy. Material policy movement between inspection and mutation fails closed. A mutation is successful only after authoritative GitHub readback matches `branch-policy-v1`.

Private repositories for which GitHub does not expose rulesets under the current account plan return `GITHUB_BRANCH_POLICY_UNAVAILABLE_BY_PLAN` before any repository setting is mutated. Overcenter does not report those repositories as protected.

Automatic integration separates GitHub governance enforcement from Overcenter transaction correctness. A standalone pull request may use the explicitly reported `exact_head_plan_fallback` only when GitHub returns a 403 policy/ruleset availability failure, review and check observation are complete, there are zero observable required checks, no review blocker exists, the branch is current, and the merge remains exact-head fenced. The normal merge transport is GitHub's asynchronous exact-head squash merge. If that transport alone returns a 403 after `exact_head_plan_fallback` has already been established, Overcenter may use GitHub's standard synchronous pull-request merge endpoint with the same exact head SHA and squash method; the result is reported as `integration_transport: direct_exact_head`. A lost direct-merge response remains indeterminate and requires authoritative reconciliation. Ordinary unprotected repositories, incomplete policy evidence, stacked pull requests, required checks, review blockers, transient policy-read failures, or ordinary integration permission denials still fail closed. The fallback permits an exact transaction; it does not create or imply GitHub branch protection.

New work branches created through `github.apply_changeset` must use one of `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, or `research` followed by a lower-case kebab description. Existing legacy branch names are grandfathered for updates until they merge or close.