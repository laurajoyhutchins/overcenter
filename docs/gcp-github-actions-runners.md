# GCP GitHub Actions runners

Overcenter supplies disposable GitHub Actions workers from the existing GCP project while GitHub remains the scheduler and user interface.

A repository opts in per job:

```yaml
runs-on: [self-hosted, overcenter-gcp]
```

No repository-specific verifier request, SHA handoff, runner-registration step, or launcher workflow belongs in the consumer repository.

## Control path

1. The private `overcenter-github-runner-autoscaler` observes admitted repositories every two seconds using authenticated ETag conditional requests. Unchanged GitHub resources return `304 Not Modified` and the autoscaler reuses the last authenticated representation.
2. The autoscaler verifies immutable repository identity and queued job state, then invokes the private `overcenter-gcp-runner-launcher` Cloud Run service with the exact repository and queued job identity. Signed `workflow_job` wake support remains available in software but is dormant until a public ingress is explicitly provisioned by an administrator.
3. The launcher converts the validated request into an immutable execution lease. Ordinary `overcenter-gcp*` labels still submit one Cloud Build; the explicit `overcenter-gcp-warm*` canary family publishes the same lease to the warm-GCE topic once that pool has been bootstrapped.
4. Both substrates independently re-read the GitHub job before minting one-time JIT configuration. Cloud Build performs that check inside the disposable build. A warm GCE host performs it in the trusted host agent before starting the user runner container.
5. The runner consumes that configuration through `run.sh --jitconfig`, executes at most one GitHub Actions job, and exits. Cloud Build workers disappear; the GCE host remains warm but never remains registered as a GitHub runner.

GitHub owns workflow scheduling, job state, step logs, cancellation, reruns, artifacts, and check presentation. GCP owns only the disposable compute substrate. No GitHub-hosted runner participates in the steady-state launch path.

## Authority boundaries

Repository admission is explicit in `config/gcp-runner-autoscaler.json` and includes GitHub repository and owner numeric IDs. Textual repository names alone are not authority.

The autoscaler implementation lives under `src/transport` and runs privately as `overcenter-runtime`. It has the GitHub App key so it can observe Actions state, but it has no Cloud Build submission authority. Conditional requests preserve the per-poll authority check: a `304 Not Modified` is accepted only as GitHub's authenticated statement that the previously observed representation is unchanged. Signed webhook code is retained as an optional wake optimization, but ordinary deployment does not configure or expose it.

The launcher runs privately as the dedicated `overcenter-runner-launcher` identity. It can submit Cloud Builds and, after one-time warm-pool bootstrap, publish execution leases to the single warm-runner Pub/Sub topic. It can act only as the bounded `overcenter-runtime` build identity and receives no GitHub credential. The recurring `overcenter-deployer` identity may attach the launcher identity to Cloud Run but does not create service accounts or mutate IAM. Cloud Run IAM admits only `overcenter-runtime` as its caller. The launch request repeats repository name, repository ID, owner ID, job ID, and runner label; the launcher checks those facts against the same immutable repository allowlist before creating compute.

The Cloud Build authorization step runs as `overcenter-runtime`, reads the existing GitHub App private key from Secret Manager, and independently revalidates the repository and queued job before minting short-lived runner configuration. The same runtime identity has Artifact Registry Reader only on the `cloud-run-source-deploy` repository so the isolated Docker worker can pull the immutable runner image; it has no image-write authority. The GitHub runner itself executes in a nested Docker container on the ordinary Docker bridge, not Cloud Build's credential-bearing `cloudbuild` network. That nested container remains intentional isolation rather than accidental Docker-in-Docker: direct execution as a credential-bearing Cloud Build step would widen the runner's GCP authority. Startup probes both metadata-token endpoints concurrently, fails closed if either is reachable, and deletes the JIT configuration file before job execution.

The runner image pins the GitHub Actions runner archive and SHA-256 digest. Deployment keys the runner image tag to the exact Git tree for `infra/gcp-runner-image`, reuses an existing Artifact Registry version when that tree has already been built, resolves the version to an immutable digest, and gives the launcher only that digest.

## Operations

The autoscaler is intentionally one warm private Cloud Run instance with CPU available between requests. Service-level scaling pins it to exactly one instance. It polls every two seconds, scans the small admitted repository set concurrently, uses ETag conditional reads for repository identity, queued/in-progress workflow runs, and job lists, preserves the per-poll immutable repository identity check, and suppresses duplicate launches for ten minutes. The conditional cache is bounded and a process restart simply repopulates it from GitHub. A process restart may cause a duplicate launch, but each build re-reads GitHub job state before registering a runner; a job that is no longer queued becomes a no-op.

The launcher is private and keeps one service-level minimum instance warm, with startup CPU boost enabled for replacement instances. It contains no GitHub secret. Its default substrate remains Cloud Build; only the explicit `overcenter-gcp-warm` label family is eligible for the warm-GCE canary route. Before submission it reads Cloud Build history using repository/job build tags and reuses any pending, queued, working, or successful build for the same GitHub job, so a control-plane restart does not create duplicate compute. Failed, cancelled, timed-out, or expired builds remain redispatchable. One Cloud Run identity token is reused across all launches in a poll. Within each runner build, the immutable runner image is pulled in parallel with GitHub authorization, and the independent repository-identity and queued-job readbacks run concurrently after the installation token is minted. The authorization step uses a pinned slim Node image; the user job still starts only after both authorization and image prefetch succeed. Runner Cloud Builds deliberately use Cloud Build's quick-start default machine instead of overriding the machine type, have an explicit one-hour execution ceiling, and expire if they remain queued for nine minutes, preventing stale verification requests from turning into delayed compute.

Deployment is explicit. A project administrator runs `infra/gcp/bootstrap-runner-launcher-iam.sh` once to create the dedicated launcher identity, grant its bounded Cloud Build permissions, allow the recurring deployer to attach that identity, grant `overcenter-runtime` read-only access to the runner-image repository, and grant only `overcenter-runtime` permission to invoke the existing private launcher service. Recurring deployment performs no IAM mutation and keeps both control-plane services private. Updating `.overcenter/gcp-runner-autoscaler-deploy-request` on the WIF-authorized infrastructure branch builds immutable runner and control images, deploys the private launcher and autoscaler revisions, and reads back service identities, image digests, source revision, instance bounds, secret placement, and private exposure.

The deployment workflow is bootstrap/update machinery only. Once the services are deployed, verification jobs do not depend on GitHub-hosted compute.


## Warm GCE canary

The warm path is a one-host managed instance group on a dedicated VPC with no ingress firewall rules and no external VM address. Cloud NAT supplies outbound access to GitHub and Google APIs. The host uses Container-Optimized OS, pre-pulls the immutable control and runner images, and runs the trusted agent with the Docker socket. User workflow code never receives that socket.

The trusted agent consumes one Pub/Sub execution lease at a time, independently revalidates immutable repository identity and the exact queued GitHub job, then requests one-time JIT configuration. It runs the user job in a fresh bridge-network Docker container. A host-level `DOCKER-USER` rule rejects access to the Compute Engine metadata address, while the runner image retains its own fail-closed metadata probes. The Pub/Sub acknowledgement deadline is renewed while execution is active; an interrupted attempt remains unacknowledged and can be redelivered, where GitHub job state is re-read before any new runner is registered.

Warm-pool creation and IAM are intentionally one-time administrator bootstrap in `infra/gcp/bootstrap-runner-warm-pool.sh`. The recurring deployer receives no Compute or network administration authority. The bootstrap grants the launcher publisher only on the runner topic and the existing runtime identity subscriber only on the runner subscription. Normal deployment may configure canary routing, but it does not create or mutate the MIG, network, NAT, or Pub/Sub IAM.
