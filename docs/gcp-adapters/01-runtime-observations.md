# Stub 01: certified runtime and queue observations

**Status:** design / draft PR only. No new provider reads or effects are wired in by this document.

**Parent:** #726; Git parent draft PR #730. **Other dependencies:** #727 Compute readbacks, #728 projected demand, #729 admitted lease link, #686 live canary, #702 approval policy.

## APIs / bounded resources

| API | Read coordinate | Required observation | Settlement limit |
| --- | --- | --- | --- |
| Pub/Sub | exact project/subscription and request identity | configuration, backlog/ack indicators and lease ownership where supported | Metric backlog zero alone never proves message acknowledgement or execution settlement |
| Cloud Scheduler | exact project/location/job | schedule, enabled/paused state, last-attempt metadata | Schedule invocation is not proof that reconciliation completed |
| Cloud Run Admin v2 | exact project/location/service/revision | revision identity, readiness/terminal condition, traffic / active configuration as supported | Healthy service does not prove a particular queued job completed |
| Compute Engine (extends #727) | exact project/zone/MIG/autoscaler/instance | target size **and** independently listed current instances plus bound instance-template identity | Desired size 0 does not prove no host or container remains |
| GitHub current adapter (join only) | immutable owner/repo/job/run/label | queued job and JIT/execution status | A GitHub status is not GCP VM or Pub/Sub acknowledgement proof |

## Provider boundaries

- Reuse the current GCP certified structural GET + schema-digest machinery. Explicitly add each API method/schema rather than accepting caller-provided URLs.
- Treat pagination, incomplete collections, stale metrics and missing required fields as `indeterminate`. Negative evidence requires a *complete and authorized* collection read or a recognized terminal absence contract.
- Distinguish raw Pub/Sub message acknowledgement evidence from aggregate backlog metrics; neither can be fabricated from a successful HTTP acknowledgement submission.
- Reconciliation joins queue/lease/job identity to an exact Overcenter authority head and approved pool policy. No auto-binding by time proximity.
- The existing Pub/Sub-backed autoscaler remains the **single** GCE capacity actuator. This adapter **never** calls setSize, resize, inserts a metric, creates another autoscaler or creates an unapproved lease.
- Preserve cold wake from a zero-host idle state; observer execution cannot depend on a VM in the pool it must observe.

## Acceptance / hostile cases

- [ ] Refuse wrong project, zone, subscription, service, revision or forged API host.
- [ ] Reject wrong owner/repo/job, stale authority head, mismatched pool label and divergent instance template.
- [ ] Distinguish Pub/Sub ack, metric backlog and live message lease expiry; never imply full ACK from empty backlog.
- [ ] Require complete enumerations to claim actual instance absence.
- [ ] Explicitly report 403 / 404 uncertainty; no guessed `not found` semantics.
- [ ] Correlate queued -> JIT -> VM awake -> runner job -> Pub/Sub ACK -> Docker/workspace teardown -> no instances.
- [ ] Admit no capacity effect; exact-head source verification and independent readback required.

## Planned implementation

Small resource-specific observers under `src/providers/gcp/`, hostile tests under `test/`, provider capability matrix updates, and a read-only operator workflow using the observer identity in stub 00. Do not introduce a new state store or alternate controller.
