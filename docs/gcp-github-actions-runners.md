# GCP GitHub Actions runners

Overcenter supplies disposable GitHub Actions workers from the existing GCP project while GitHub remains the scheduler and user interface.

A repository opts in per job:

```yaml
runs-on: [self-hosted, overcenter-gcp]
```

No repository-specific verifier request, SHA handoff, runner-registration step, or launcher workflow belongs in the consumer repository.

## Control path

1. The one-instance `overcenter-github-runner-poller` Cloud Run worker pool polls the explicitly bound repositories for queued jobs requesting both `self-hosted` and `overcenter-gcp`.
2. The autoscaler verifies immutable repository identity and invokes the private `overcenter-gcp-runner-launcher` Cloud Run service with the exact repository and queued job identity.
3. The launcher submits one Cloud Build directly. It does not hold the GitHub App key.
4. The build independently re-reads the GitHub job, rejects a repository or label mismatch, requests a one-time JIT configuration bound to the job/build-specific runner identity and labels, and starts the pinned runner image.
5. The runner consumes that configuration through `run.sh --jitconfig`, executes at most one GitHub Actions job, and exits.
6. A secret-bearing settlement step independently re-reads the exact GitHub job and requires the exact JIT runner name plus terminal job status. A clean runner-process exit without an actual GitHub job claim is therefore a substrate failure, not success. The Cloud Build worker then disappears.

GitHub owns workflow scheduling, job state, step logs, cancellation, reruns, artifacts, and check presentation. GCP owns only the disposable compute substrate. No GitHub-hosted runner participates in the steady-state launch path.

## Authority boundaries

Repository admission is explicit in `config/gcp-runner-autoscaler.json` and includes GitHub repository and owner numeric IDs. Textual repository names alone are not authority.

The autoscaler implementation lives under `src/transport` and runs as a one-instance Cloud Run worker pool under `overcenter-runtime`. It has the GitHub App key so it can observe Actions state, but it has no Cloud Build submission authority and exposes no request-serving endpoint.

The launcher runs privately as the dedicated `overcenter-runner-launcher` identity. It can submit Cloud Builds and act only as the bounded `overcenter-runtime` build identity, but receives no GitHub credential. The recurring `overcenter-deployer` identity may attach the launcher identity to Cloud Run but does not create service accounts or mutate IAM. Cloud Run IAM admits only `overcenter-runtime` as its caller. The launch request repeats repository name, repository ID, owner ID, job ID, and runner label; the launcher checks those facts against the same immutable repository allowlist before creating compute.

The Cloud Build authorization step runs as `overcenter-runtime`, reads the existing GitHub App private key from Secret Manager, and independently revalidates the repository and queued job before minting short-lived runner configuration. The same runtime identity has Artifact Registry Reader only on the `cloud-run-source-deploy` repository so the isolated Docker worker can pull the immutable runner image; it has no image-write authority. The GitHub runner itself executes in a nested Docker container on the ordinary Docker bridge, not Cloud Build's credential-bearing `cloudbuild` network. Startup fails closed if a GCP credential environment variable or metadata token is reachable, and the JIT configuration file is deleted before job execution.

The runner image pins the GitHub Actions runner archive and SHA-256 digest. Deployment resolves the built image to an immutable Artifact Registry digest, and the launcher uses that digest rather than a mutable tag.

## Operations

The autoscaler is intentionally one continuously running Cloud Run worker-pool instance, which is the GCP resource intended for pull-based background work. It polls every ten seconds, scans repositories and active runs with bounded parallel reads, revalidates immutable repository identity periodically instead of on every poll, reuses one launcher identity token per poll, and suppresses duplicate launches for ten minutes. A process restart may still cause a duplicate launch, but each build re-reads GitHub job state before registering a runner; a job that is no longer queued becomes a no-op.

The private launcher keeps one warm Cloud Run service instance to remove launch-path cold starts. It contains no GitHub secret and performs one operation: submit the exact runner build described by trusted software. Runner builds expire from the Cloud Build queue after 90 seconds so stale verification demand cannot turn into delayed compute.

Deployment is explicit. A project administrator runs `infra/gcp/bootstrap-runner-launcher-iam.sh` once to create the dedicated launcher identity, grant its bounded Cloud Build permissions, allow the recurring deployer to attach that identity, grant `overcenter-runtime` read-only access to the runner-image repository, and grant only `overcenter-runtime` permission to invoke the existing private launcher service. Recurring deployment performs no IAM mutation. Updating `.overcenter/gcp-runner-autoscaler-deploy-request` on the WIF-authorized infrastructure branch builds immutable runner and control images, deploys the private launcher, stages the autoscaler worker pool at zero instances, verifies its exact identity/image/secrets, retires the legacy request-serving autoscaler, then starts exactly one worker-pool instance. Deployment reads back identities, image digests, source revision, invoker policy, secret placement, scaling, and private exposure.

The deployment workflow is bootstrap/update machinery only. Once the services are deployed, verification jobs do not depend on GitHub-hosted compute.
