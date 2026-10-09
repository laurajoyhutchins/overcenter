# Warm-runner lifecycle observation

The GCE warm host emits structured JSON records from
`src/transport/gce-runner-agent.ts` for each received Pub/Sub lease. The
events deliberately carry immutable repository, owner, job, Pub/Sub message,
and per-delivery attempt identities. The attempt identifier distinguishes
redelivery from repeated log ingestion.

## Diagnostic evidence and failure behavior

The host records:

1. lease received;
2. exact queued-job readback, then JIT authorization or a stale-job result;
3. container started and observed zero exit code;
4. Docker DELETE followed by **independent Docker GET returning 404** for
   the exact container identifier;
5. workspace removal followed by **lstat returning ENOENT** for the exact
   workspace;
6. Pub/Sub acknowledgement HTTP request accepted, or uncertain.

Container removal errors are no longer swallowed. Any unsuccessful deletion,
ambiguous Docker readback, remaining workspace, or acknowledgement error leaves
the lease unresolved. An unresolved lease is not acknowledged and is left for
provider redelivery/reconciliation. Failed acknowledgement calls are recorded
as uncertain rather than crashing the host loop.

An authorized job that is no longer queued can skip the container, but still
requires workspace absence before ACK. An extension failure is a diagnostic
warning and prevents a trace from being classified as complete.

## Inspecting an exported host log

The runner currently writes records to the trusted host agent's stdout. To
analyze a captured JSONL stream locally:

```bash
node --experimental-strip-types scripts/report-warm-runner-events.ts host-stdout.jsonl
```

The reporter groups exact attempts and returns
`reported-cleanup-and-ack-request`, `incomplete`, or `contradictory`.
It exits nonzero if there are no operational events, malformed operational
records, or incomplete attempts. It ignores unrelated stdout lines. Repeated
identical records are idempotent; missing sequence numbers and conflicting
same-sequence records never become success.

**This is host-reported diagnostic evidence, not independently certified
provider observation.** A Docker GET result is an observation by the host, not
an independently verified Cloud Logging receipt. Successful Pub/Sub
`:acknowledge` HTTP return does not establish that a message was durably
removed from the subscription. The analyzer does not write authority or emit
Overcenter DONE.

## Remaining operational integration

This source change is not live deployment of the new host image. To make the
observation operational end-to-end:

- deploy the new immutable host-control image through the existing protected
  infrastructure path and read back its exact image digest and running host;
- provide durable remote collection of the host event stream with a narrowly
  permitted reader, not extra administrative permissions on the worker;
- correlate GitHub run/job evidence, Pub/Sub message/ACK state, Docker/workspace
  cleanup, managed instance enumeration, and actual return to zero;
- re-read the authoritative observation frontier and preserve missing/unknown
  as unresolved. No GCP target-size metric or host log alone is proof of idle
  absence or successful settlement.

Track the live cold-wake / ACK / teardown / zero verification in #686, and
observation support envelopes in #420. These events can supply diagnostic
breadcrumbs to those observers but **cannot substitute for their certified
readbacks**.
