# Private source ferry

The private source ferry lets an external verifier materialize an exact private repository snapshot without placing private source in a public repository or on a GitHub-hosted public runner.

For Arcata, the authority path is:

```text
laurajoyhutchins/arcata exact commit
        |
        | authenticated GitHub archive stream
        v
owner-controlled self-hosted runner
        |
        | OpenSSL CMS AES-256-GCM, streamed without plaintext checkout
        v
public Overcenter Actions artifact (ciphertext only, retained 1 day)
        |
        | authenticated artifact download
        v
verifier VM
        |
        | decrypt + reconstruct Git tree
        v
materialized source accepted only if tree SHA matches GitHub read-back
```

## Public control point

Requests are accepted only from the repository owner on locked Overcenter issue #584. The request grammar is one line:

```text
/ferry arcata <40-hex-commit> <32-hex-nonce> <base64-DER-X509-certificate>
```

The certificate contains only an ephemeral public key. The corresponding private key stays in the verifier VM.

The workflow hard-codes `laurajoyhutchins/arcata`; a request cannot select another private repository. It also rejects symbolic refs such as `main`, extra tokens, control-character/newline payloads, and malformed commit or nonce values.

## One-time runner setup

Register an owner-controlled self-hosted runner for `laurajoyhutchins/overcenter` with the custom label `arcata-ferry`. The runner needs Bash, curl, OpenSSL with CMS AES-256-GCM support, and Python 3. It does not need an Arcata checkout.

Create the Overcenter Actions secret `ARCATA_FERRY_TOKEN` as a fine-grained GitHub token restricted to `laurajoyhutchins/arcata` with read-only repository contents and metadata access. Do not grant write access or access to any other private repository.

The workflow is triggered only by an owner comment on the locked control issue. Fork pull requests cannot reach the ferry job or its secret.

## Request from a verifier VM

Generate an ephemeral certificate and key:

```bash
openssl req -x509 -newkey rsa:3072 -nodes \
  -keyout recipient-key.pem \
  -out recipient-cert.pem \
  -subj '/CN=Arcata private source ferry' \
  -days 1

cert_b64="$(openssl x509 -in recipient-cert.pem -outform DER | openssl base64 -A)"
nonce="$(openssl rand -hex 16)"
```

Post the request line to issue #584 using the exact Arcata commit SHA. The workflow uploads an artifact named `private-source-ferry-<nonce>` containing only:

- `manifest.json`, which identifies the requested commit, its authoritative Git tree SHA, workflow/run identity, and ciphertext digest;
- `source.tar.gz.cms`, the GitHub source archive encrypted to the ephemeral certificate.

The private token, private source bytes, and private decryption key are never uploaded.

## Materialize and verify

After downloading the artifact into the verifier VM, run:

```bash
bash scripts/materialize-private-source-ferry.sh \
  manifest.json \
  source.tar.gz.cms \
  recipient-cert.pem \
  recipient-key.pem \
  /path/to/arcata
```

Materialization fails closed unless the ciphertext digest matches the manifest, CMS authenticated decryption succeeds, and the extracted files reconstruct exactly the Git tree SHA reported by GitHub for the requested commit.

The materializer removes its temporary plaintext archive and temporary Git metadata after verification. The destination contains only the verified Arcata source tree.

## Trust boundary

The public Overcenter repository owns the transport software and public workflow. Arcata remains the private Git authority. The self-hosted runner is trusted only to read the requested Arcata commit and encrypt the byte stream to the verifier's ephemeral public key. The public artifact store is treated as untrusted transport because it receives ciphertext only.

A hard failure or compromise of the self-hosted runner remains inside the trusted transport boundary because plaintext Arcata bytes necessarily pass through runner memory before encryption. The workflow avoids persisting those bytes to the runner filesystem.
