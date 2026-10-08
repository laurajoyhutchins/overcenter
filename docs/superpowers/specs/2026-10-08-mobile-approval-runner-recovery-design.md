# Design: Mobile Approval for Runner Recovery

> Status: approved in chat for specification and review; no implementation authorization implied.
> Scope: connect GitHub Mobile owner approval to the existing #689 runner autoscaler recovery operation.

## Goal

Add a trusted, exact-request approval gate before the existing runner recovery operation can obtain its Google Cloud identity or mutate infrastructure. Each request is a single recovery of the runner control plane from the current accepted infrastructure branch revision. Approval authorizes only the request that was shown; it does not prove that deployment settled.

## Existing operation and hard prerequisite

PR #695 proposes an owner-only manual workflow that checks out the exact infrastructure revision, authenticates as the existing `overcenter-deployer` through Workload Identity Federation, and runs `infra/gcp/deploy-runner-autoscaler.sh`. PR #704 installs that workflow on `work/gcp-cloud-run-cloud-sql-bootstrap`. Both PRs are still open in the observed state.

The current owner-approval environment is protected, requires `laurajoyhutchins`, has administrator bypass disabled, and is restricted to `main`. Keep those settings. The environment must not be broadened to a branch containing candidate workflow code.

The accepted source-recovery verifier rejects `.github` paths as recovery-root changes, and ordinary source admission rejected PR #710's protected workflow edit. Therefore workflow implementation is blocked until an independently reviewed and authorized control-plane source transition exists. Do not use PR #700 to self-install or self-authorize that transition, weaken the verifier, or merge protected workflow changes through ordinary admission.

## Request and approval flow

1. An owner dispatches a trusted workflow definition from `main` with a short reason. The workflow rejects non-owner actors and reruns before preparing a request.
2. A read-only prepare job resolves the current `work/gcp-cloud-run-cloud-sql-bootstrap` head itself. It verifies accepted source provenance and required exact-head checks, then binds the target commit, tree, workflow and deployment-script blob digests, and the operation’s fixed resource and identity scope. The owner does not copy SHAs into dispatch inputs.
3. The job writes and publishes an immutable manifest before any environment wait. The manifest includes:
   - unique request ID (`run_id.attempt`), creation time, expiration, and reason;
   - operation kind and repository;
   - exact target ref, commit, tree, and accepted verification evidence references/digests;
   - exact deployment workflow and script paths plus blob digests;
   - canonical resource set derived from the accepted operation definition;
   - existing WIF principal and its approved privilege ceiling;
   - human-readable impact, including that this operation can rebuild images and deploy Cloud Run services;
   - manifest digest and declared side effects.
4. A separate approval job with no token permissions enters `overcenter-owner-approval`. Its summary and downloadable artifact display the same manifest digest and impact. No Cloud credential, ID token, provider API call, or mutation runs before approval.
5. After the environment gate succeeds, a separate execution job checks the GitHub run-approvals record and requires the expected owner identity, the exact environment, and the current request attempt. It checks expiration and replay, re-reads the infrastructure branch head and accepted verification evidence, and fails closed if any bound value moved.
6. Only after those checks does the job obtain the existing WIF identity and execute the existing script at the exact approved commit. It cannot accept arbitrary refs, resources, service accounts, or scripts. No GCP roles or GitHub secrets are added.
7. The workflow independently reads back the deployed revision and required service postconditions. A settlement job records approved, rejected, expired, stale, failed, indeterminate, or settled outcome, GitHub reviewer login, run ID/attempt, request ID, exact target, manifest digest, and verification evidence. Approval alone is never recorded as deployment success.

## Authority and replay rules

- The request workflow and environment gate are sourced only from accepted `main`; the target infrastructure branch supplies only the exact operation revision bound in the manifest.
- The environment remains restricted to `main`, with the owner as required reviewer and administrator bypass disabled.
- Workflow-level permissions default to none. Prepare gets only GitHub read access. The approval job has no token permissions. The post-approval job gets only the read scope required to verify the review record and `id-token: write` for the existing WIF exchange.
- The workflow requires original and triggering actors to be the repository owner, event `workflow_dispatch`, expected repository and trusted workflow ref, `run_attempt == 1`, and a not-expired request.
- A moved target ref, changed tree, missing/failed source evidence, different reviewer, stale approval, repeat attempt, changed script digest, or unavailable required API evidence fails closed before provider mutation.
- The deployment job does not cancel an active operation to make room for a new one. Duplicate requests wait or fail without executing a second mutation.

## Canary and activation sequence

The no-side-effect GitHub Mobile canary has passed: the owner reports opening and rejecting its push notification, GitHub records the rejection, and no operation ran. That proves the notification and environment-review interaction, not the GCP executor.

Before enabling the recovery executor, the implementation must pass hostile tests and a separately approved, harmless exact operation through the same request, approval, identity boundary, and independent readback path. The runner deployment itself is not assumed harmless. Until a benign operation and its postconditions are identified and verified, the mutation job remains disabled. Any later real recovery requires approval of its own exact request; the canary approval cannot authorize it.

## Verification requirements

Hostile coverage must prove that non-owner initiation, non-owner re-review, changed branch head/tree, changed workflow/script digest, failed or absent source checks, expired request, replay/rerun, wrong environment, wrong reviewer, malformed resource scope, and unavailable review evidence cannot reach WIF authentication or the deployment script. Rejection, timeout, partial deployment, and unclear provider outcome must produce no additional mutation and a truthful non-settled receipt.

Successful verification requires exact-head CI, the protected-source control-plane transition handled by its independent authorization path, a rejected and an approved mobile canary, the harmless exact operation with independent readback, and durable receipts for both decision and settlement. Keep #702 open until those end-to-end conditions are met.

## Non-goals

- Expanding environment branch access or permitting candidate workflow code to request owner approval.
- Replacing owner authorization, source verification, WIF, exact-revision checks, the existing deploy script, or provider readback.
- Bootstrapping or approving a new verifier with the verifier it installs.
- Automatically running the recovery operation after the existing notification canary.

## Self-review checklist

- [x] Scope is one existing operation and preserves its identity/script.
- [x] Environment remains protected and main-only.
- [x] No identity or provider side effect occurs before owner approval.
- [x] Exact request, reviewer, replay, expiry, and settlement evidence are bound.
- [x] Protected workflow edits remain blocked pending an independent source-transition mechanism.
- [x] The mobile canary is separated from authorization to deploy.
- [x] The first operation-level test is required to be harmless and independently read back.
