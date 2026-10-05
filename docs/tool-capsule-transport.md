# Tool capsule transport

Tool capsule transport moves an already-authorized Python wheel closure across a network boundary without making dependency-selection decisions inside the transport.

The request is the authority for what may be fetched. It binds the package closure to an exact source revision and dependency-authority Git blob, but v1 does **not** prove that the request was correctly derived from that authority file. A caller that needs that claim must generate or verify the request against the exact authority file before dispatch.

```text
exact project revision + dependency authority
              |
       derived request
  exact versions + allowed hashes
              |
              v
 trusted networked materializer
  pip download --no-deps
  --require-hashes
              |
      immutable capsule
              |
              v
 permissionless consumer
  exact-byte verification
  network namespace removed
  pip install --no-index
  pip check
```

## Contract

`src/transport/tool-capsule.ts` owns request validation, deterministic hashed-requirement rendering, manifest construction, and exact capsule verification. The workflow is plumbing between trust domains.

`tool-capsule/request/v1` contains:

- exact source repository and 40-hex revision;
- repository-relative dependency-authority path and exact Git blob SHA;
- Python major/minor and the supported `linux-x86-64` platform;
- the complete package closure, with one exact version and one or more authorized SHA-256 wheel hashes for each normalized package name.

The materializer never resolves transitive dependencies. Every package must already be present in the request. `pip download` runs with `--no-deps`, exact versions, `--require-hashes`, and binary-only mode. The resulting wheelhouse must contain exactly one wheel per declared package.

The consumer receives no repository checkout and `permissions: {}`. It re-verifies the request and wheel manifest, regenerates the requirements file, removes its network namespace, installs only from the capsule with `--no-index --no-deps --require-hashes`, and runs `pip check` to reject an incomplete closure.

## Dispatch

Base64-encode a validated request and dispatch `.github/workflows/tool-capsule.yml` with the request's Python major/minor as `python_version` and the encoded bytes as `request_base64`.

The successful run emits two seven-day artifacts:

- `tool-capsule-<request-sha256>` containing the deterministic capsule and its SHA-256 receipt;
- `tool-capsule-<request-sha256>-receipt` recording successful permissionless, network-isolated installation.

Offline consumers should verify the capsule digest before caching it by request or manifest digest. Artifact retention is intentionally short because the transport is reproducible; durable local caches are content-addressed realizations, not a second dependency authority.

## Non-claims

The transport proves faithful realization of a declared exact package closure. It does not prove that the closure was derived correctly from a particular dependency-authority file, that PyPI metadata is trustworthy beyond the declared hashes, or that transported tools are semantically correct. Those are separate evidence obligations.
