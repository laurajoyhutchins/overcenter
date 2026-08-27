# Semantic GitHub release command

`github.release.create` is Overcenter's narrow semantic operation for creating an immutable Git tag and a GitHub Release from one exact Git commit.

## Authority and scope

GitHub remains authoritative for repositories, commits, refs, tags, releases, release identifiers, URLs, and timestamps. Overcenter stores only command correlation, idempotency/recovery progress, and the verified receipt required to make retries safe. The receipt is evidence, not a GitHub mirror.

The command does not edit, retarget, force-update, delete, replace, upload assets, generate release notes, infer versions, infer a release commit, run Actions, or publish packages.

## Semantic request

The MCP transport tool is `github_release_create`; the semantic command is `github.release.create`. Both accept the same shared input schema:

- `repo`: `owner/name`
- `target_sha`: exact 40-character Git commit SHA
- `tag_name`: Git tag name
- `name`: GitHub Release title
- `body`: release notes supplied by the caller
- `draft`: boolean
- `prerelease`: boolean
- `expected_state.tag`: `absent` or `present_same_commit`
- `expected_state.release`: `absent` or `present_matching`
- `idempotency_key`: semantic retry identity
- `run_id`: orchestration correlation

No GitHub REST `target_commitish`, ref-update flags, transport token, or lower-level release bookkeeping is accepted.

## Safety and recovery

Before mutation Overcenter reads the repository, exact commit, tag, and release from GitHub and applies the caller's expected-state fence. An existing tag at another commit or an existing materially different release is a conflict. There is no force-update or implicit edit path.

For a new release, Overcenter creates a lightweight `refs/tags/<tag>` ref at the exact SHA first, then creates the GitHub Release referencing that already-established tag without `target_commitish`. It rereads GitHub after mutation and reports success only when the tag resolves to the requested SHA and the release title/body/draft/prerelease state match exactly.

A durable release receipt binds `repo + idempotency_key` to a canonical semantic request hash that excludes the retry identity itself, matching Overcenter's existing idempotency convention. If tag creation succeeded but release creation is uncertain or fails, the receipt records partial progress. Re-running the same request may accept the matching tag produced by that earlier attempt and continue with release creation. Reusing the same identity for different semantics fails with `IDEMPOTENCY_CONFLICT`.

## Evidence

Successful receipts include the requested and verified commit SHA, tag/ref identity, GitHub release ID and URL, release title, draft/prerelease state, GitHub creation/publish timestamps, pre/post classification, created-vs-already-satisfied outcome, verification result, idempotency identity, and semantic request hash.

## GitHub App permission

Creating Git refs and GitHub Releases both require repository **Contents: write**. The `release` capability therefore requests only `contents: write` and fails closed if unavailable. Overcenter already requires `contents: write` for its changeset capability, so this command does not broaden the installed App's repository permission set when that existing capability is installed.
