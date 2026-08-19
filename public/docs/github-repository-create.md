# GitHub repository creation

`github.repository.create` is a narrow provisioning command for repositories owned by `laurajoyhutchins`.

## Fixed policy

The command creates only:

- owner: `laurajoyhutchins`
- visibility: private
- initialization: disabled (`auto_init=false`)

Callers can provide only the repository `name`, an optional `description`, and optional orchestration `run_id`. They cannot supply a different owner, public visibility, templates, README initialization, licenses, or arbitrary GitHub permissions.

## Authentication boundary

Ordinary GitHub repository mutations continue to use short-lived GitHub App installation tokens with command-owned permission profiles.

Repository creation uses a GitHub App **user access token** because GitHub's personal-repository creation endpoint requires user authority. Authorization is obtained with the GitHub device flow through `github_repository_authorization` or `/api/github-repository-authorization`.

The control plane discovers the GitHub App client ID from the authenticated App identity. Device flow therefore does not require a client secret. The resulting access and refresh tokens are encrypted with AES-GCM before persistence. The wrapping key is deterministically derived, with a domain-separation label, from the existing Hatchable-protected GitHub App private key. Token plaintext is never returned, persisted, or logged.

Expiring user tokens are refreshed automatically. Device-flow refresh does not require a GitHub App client secret. If the App private key rotates, the stored credential intentionally fails closed and user authorization must be repeated.

## Authorization

1. Call `github_repository_authorization({action:"start"})`.
2. Open the returned GitHub verification URI and enter the returned user code.
3. Call `github_repository_authorization({action:"complete"})` after approval.
4. `status` reports readiness without exposing credentials.

If GitHub reports `GITHUB_USER_AUTH_DEVICE_FLOW_DISABLED`, enable Device Flow in the GitHub App settings and start again.

Authorization is accepted only when `/user` resolves to `laurajoyhutchins`. A token for any other account fails closed.

## Determinism and recovery

Creation preflights the exact repository name. An existing matching private repository is an idempotent success. An incompatible existing repository is a conflict.

A successful create is read back when the new repository is accessible to the App. If transport is lost after the mutation, the command re-reads the repository and converges when the intended state can be proven. Otherwise it returns `GITHUB_REPOSITORY_CREATE_INDETERMINATE` with `may_have_mutated=true`; callers must reconcile rather than retry under a different name.

After creation the command probes whether the existing GitHub App installation can mint a normal repository-scoped installation token. If the installation uses selected repositories and the new repository is not yet selected, creation can still succeed with `installation_access=false`; that is the remaining GitHub-side authorization boundary.