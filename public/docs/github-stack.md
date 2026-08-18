# GitHub stack reconciliation

`github.stack.reconcile` projects an already-linear chain of repository pull requests into GitHub's native stacked-pull-request object. GitHub remains authoritative for the stack.

Input contains `repo` and an ordered `pull_requests` array from bottom to top. Every item supplies the pull request number and its exact current head SHA. Before mutation the command rereads every PR, verifies the exact heads, rejects fork-based layers and closed-unmerged PRs, and requires each upper PR base ref to equal the lower PR head ref.

If every PR already belongs to the same GitHub stack and the stack order exactly matches the request, the command succeeds idempotently. Partial membership, membership in multiple stacks, or a different existing composition is an expected conflict. The command does not unstack, reorder, force-push, rebase, merge, or otherwise destructively restructure a live stack.

When no requested PR is stacked, the command calls GitHub's native `POST /repos/{owner}/{repo}/stacks` endpoint using the command-owned `pull_requests:write` GitHub App permission, then rereads the returned stack number and verifies the exact PR ordering.

`github.review_packet` includes the pull request's GitHub stack membership when GitHub returns it. No Hatchable stack database is introduced.