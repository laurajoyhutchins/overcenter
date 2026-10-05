# GCP GitHub Actions runners

Overcenter supplies disposable GitHub Actions workers from the existing GCP project while GitHub remains the scheduler and user interface.

A repository opts in per job:

```yaml
runs-on: [self-hosted, overcenter-gcp]
```

No repository-specific verifier request, SHA handoff, or runner-registration step belongs in the consumer workflow.

## Control path

1. The private `overcenter-github-runner-autoscaler` Cloud Run service polls the explicitly bound repositories for queued jobs requesting both `self-hosted` and `overcenter-gcp`.
2. The autoscaler verifies immutable repository identity and dispatches `.github/workflows/gcp-runner-launch.yml` in Overcenter.
3. The public controller authenticates to GCP through Workload Identity Federation and submits one Cloud Build.
4. The build independently re-reads the GitHub job, rejects a repository or label mismatch, mints a short-lived repository runner registration token, and starts the pinned runner image.
5. The runner registers with `--ephemeral`, executes at most one GitHub Actions job, and exits. The Cloud Build worker then disappears.

GitHub owns workflow scheduling, job state, step logs, cancellation, reruns, artifacts, and check presentation. GCP owns only the disposable compute substrate.

## Authority boundaries

Repository admission is explicit in `config/gcp-runner-autoscaler.json` and includes GitHub repository and owner numeric IDs. Textual repository names alone are not authority.

The autoscaler runs privately as `overcenter-runtime` and has the GitHub App key only so it can observe Actions state and request the public launcher workflow. It does not submit Cloud Builds.

The launcher runs from the WIF-authorized Overcenter infrastructure ref and uses `overcenter-deployer` only to submit/read the build. The Cloud Build uses `overcenter-runtime` to read the existing GitHub App private key and mint a one-hour runner-registration token. The GitHub runner is ephemeral and receives no ambient GCP credential.

The runner image pins the GitHub Actions runner archive and SHA-256 digest. A deployment builds an image tagged to the exact controller Git revision. The launcher for that revision uses the matching image tag.

## Operations

The autoscaler is intentionally one warm private Cloud Run instance with CPU available between requests. It polls every ten seconds and suppresses duplicate dispatches for ten minutes. A process restart may cause a duplicate launcher, but each launcher re-reads GitHub job state before registering a runner; a job that is no longer queued becomes a no-op.

Deployment is explicit. Updating `.overcenter/gcp-runner-autoscaler-deploy-request` on the WIF-authorized infrastructure branch builds the exact runner image and deploys the exact autoscaler revision. The deployment fails closed if Cloud Run identity, source revision, instance bounds, or private exposure read back incorrectly.
