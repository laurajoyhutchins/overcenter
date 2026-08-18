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
- caller-selected required checks enforced in strict mode;
- no bypass actors.

The command recognizes the older `Exact-head review clearance` and `Hatchable required checks: ...` rulesets as migration predecessors. It will not overwrite classic branch protection or layer over an unowned ruleset that contributes effective policy. Material policy movement between inspection and mutation fails closed. A mutation is successful only after authoritative GitHub readback matches `branch-policy-v1`.

Private repositories for which GitHub does not expose rulesets under the current account plan return `GITHUB_BRANCH_POLICY_UNAVAILABLE_BY_PLAN` before any repository setting is mutated.

New work branches created through `github.apply_changeset` must use one of `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, or `research` followed by a lower-case kebab description. Existing legacy branch names are grandfathered for updates until they merge or close.