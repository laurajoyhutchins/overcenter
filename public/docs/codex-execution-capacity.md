# Codex execution capacity

Overcenter models Codex execution capacity as policy and bounded observations, not as a registry of computers or cloud hosts.

## Boundary

The v1 model has three execution classes:

- `codex_cloud` is the preferred class when a future supported dispatcher and trustworthy capacity observation say it is usable.
- `codex_local` is a single unresolved local-execution stub. It does not identify, select, or register a physical device.
- `external` is an abstract future class and remains unbound.

The model deliberately contains no device name, hostname, VM identity, region, cloud-provider identity, or similar execution-environment coordinate.

Overcenter may decide what capabilities execution requires and which execution class policy prefers. A later resolver may decide how an unresolved class is implemented. That resolver is outside the v1 contract.

## Included Codex capacity

Allowance observations are explicitly one of:

- `known`: a fresh authoritative observation is available;
- `stale`: a prior observation is retained but must not be treated as current;
- `unknown`: no quota value is claimed.

Known or stale observations may contain only bounded primary/secondary usage windows, their `used_percent`, reset timestamps, and the observation timestamp. Unknown observations contain no inferred quota values.

A future live adapter can populate this observation from an authoritative Codex usage surface without changing the execution-class contract.

## Dispatch truthfulness

The initial model does **not** claim that Overcenter can dispatch Codex Cloud, local Codex, or an external worker. Each execution class is returned with `dispatch_supported: false` until a separately verified dispatch mechanism exists.

Preference is policy, not evidence of availability.

## Spending policy

Automatic paid fallback is disabled. `paid_fallback_allowed` is always `false` in v1, and attempts to enable it fail closed.

This prevents exhaustion of included Codex capacity from silently becoming OpenAI API or purchased-credit spending.

## Non-goals

This model does not provide:

- a local-device registry or selector;
- a managed VM or external runner configuration;
- an OpenAI API-funded Codex worker;
- a quota scraper;
- a programmatic Codex Cloud dispatch shim;
- a second execution authority.

Execution authority, leases, receipts, evidence, and recovery remain Overcenter responsibilities. This contract only describes execution capacity and routing policy facts that Overcenter can state truthfully.
