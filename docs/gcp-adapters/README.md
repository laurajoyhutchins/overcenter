# Google Cloud adapter delivery map (draft only)

Parent: [#726](https://github.com/laurajoyhutchins/overcenter/issues/726). This folder contains **work specifications**, not executable provider support. No file here permits a Google Cloud mutation or establishes owner approval.

## Existing implementation slices

- [#727](https://github.com/laurajoyhutchins/overcenter/pull/727): certified Compute Engine MIG/autoscaler reads, pending independent verification and scoped observer permissions.
- [#728](https://github.com/laurajoyhutchins/overcenter/pull/728): pure authority-head-derived GCP runner demand, with **no** infrastructure actuation.
- [#729](https://github.com/laurajoyhutchins/overcenter/issues/729): guarded link from demand to existing lease/queue/JIT execution, **never** a competing VM resizing controller.
- [#686](https://github.com/laurajoyhutchins/overcenter/issues/686): prove the actual idle -> awake -> settled -> idle lifecycle.
- [#702](https://github.com/laurajoyhutchins/overcenter/issues/702): protected owner approval for administrative authority.

## Draft PR delivery sequence

1. `00-observer-authority.md`: dedicated readback identity (IAM, Service Usage, federation), no deployer privilege expansion.
2. `01-runtime-observations.md`: Pub/Sub, Scheduler, private Cloud Run revision observations and independent zero-capacity evidence.
3. `02-build-artifact-evidence.md`: Cloud Build, Storage, Artifact Registry, Logging/Monitoring evidence.
4. `03-governed-effects.md`: bounded Cloud Run deployment and autoscaler **policy** reconciliation, owner-gated administrative operations.

These plans are sequential review slices; execution dependencies also include #727, #728, #729, #686, and #702 as specified individually.

## Additional Google APIs (deferred until driven by admitted work)

| API family | Candidate contract | First capability | Safety boundary |
| --- | --- | --- | --- |
| Cloud SQL Admin | instance configuration and state | Existing certified GET | No instance change without exact resource guard and operations settlement |
| Secret Manager | version references and identity | Version metadata read | Never copy secret contents into durable receipts |
| Cloud Resource Manager | project identity and hierarchy | Read-only project observation | No broad project IAM writes |
| Cloud Asset Inventory | inventory and drift | Read-only inventory snapshot | Snapshot alone cannot prove per-resource settlement |
| Billing / Budgets | cost observations and alerts | Read-only costs and budgets | Alert is not an enforced hard spending cap |
| VPC, DNS and networking | declared topology | Read-only observations | Separate owner approval for network/firewall changes |
| BigQuery | bounded query jobs | Read-only job/result | Query result identity + cost envelope |
| Vertex AI / Gemini | model invocation/evaluation | Receipted invocation | Model judgment is never execution authority |
| Google Workspace | Drive, Docs, Sheets, Gmail, Calendar | Scoped reads | Separate user-data authorization, never ambient infra privileges |

### Common acceptance contract

Every resource must independently define coordinate, positive observation, negative/absence proof, narrowly allowed effect, provider preconditions, async operation finality and independently observed postcondition. Missing authority or uncertain observations **HOLD**. No generic `gcloud`, arbitrary REST, unbounded admin workflow or speculative retry.

The existing Pub/Sub-backed managed instance group autoscaler remains the sole GCE capacity actuator until an explicitly approved migration. An observed desired size of zero is not proof that no VM or stale lease remains.
