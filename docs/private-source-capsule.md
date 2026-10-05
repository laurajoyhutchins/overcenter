# Private source capsule transport

This transport materializes an exact private Git source tree in an external worker when an authenticated connector can already read the repository's Git objects.

Authority stays with the source repository. The connector is a byte carrier: it reads an exact commit, its authoritative tree, and the ordinary blob bytes. A producer writes those bytes into a content-addressed cache keyed by Git blob SHA and emits a manifest containing repository, exact 40-hex revision, authoritative tree SHA, path, mode, blob SHA, byte size, and SHA-256.

The consumer trusts none of the transported bytes merely because they arrived. `src/transport/private-source-capsule.ts` verifies each cache entry is a regular file, verifies byte size and SHA-256, recomputes its Git blob SHA, reconstructs the complete Git tree from path/mode/blob identities, and requires that tree to equal the authoritative tree SHA. Materialization then occurs through a temporary directory and atomic rename.

The v1 contract deliberately supports only ordinary Git blobs with modes `100644` and `100755`. Symlinks, submodules, symbolic revisions, unsafe paths, duplicate paths, truncated/incomplete trees, and undeclared bytes fail closed. Add support only with an explicit contract extension.

For Arcata the intended flow is:

```text
Arcata exact commit + tree
        |
authenticated GitHub connector
        |
manifest + content-addressed Git blobs
        |
private-source-capsule verifier
        |
verified exact worktree
        |
offline tool capsule + Arcata checks
```

This replaces the reverted encrypted ferry's operational machinery. It needs no Arcata token in Overcenter, no self-hosted ferry runner, no public private-source artifact, and no encryption layer because private bytes move directly from the authenticated connector into the verifier boundary.

The transport does not choose a revision, infer repository authority, authorize code execution, or prove source correctness. It proves only that the realized ordinary-file worktree is exactly the declared authoritative Git tree.
