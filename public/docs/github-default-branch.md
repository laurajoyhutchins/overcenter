# GitHub default-branch migration

`github.default_branch.migrate` is a narrow exact-ref operation for repositories whose established default branch must be renamed by create-and-switch semantics.

Input is exactly `repo`, `from`, `to`, and `expected_head` (plus optional MCP correlation `run_id`). The current repository default must be `from`, and `from` must point at `expected_head`. If `to` is absent, the command creates `refs/heads/<to>` at exactly that SHA. If it already exists, it must point at the same SHA.

Immediately before mutation the command rereads both repository default and source head. It then changes only the repository default branch and verifies that GitHub reports `to` as default at the exact expected SHA.

The old branch is never deleted by this command. Open pull requests, CI consumers, documentation, and other refs must be inspected and retargeted separately. Once nothing depends on the old branch, `github.delete_branch` performs the exact-head, PR-aware deletion.