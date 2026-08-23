# Skill execution contracts

## Goal

Make worker skills first-class orchestration contracts without turning reasoning procedures into deterministic RPCs or creating a second execution authority.

## Architecture

The Portfolio Control Plane remains the sole runtime authority. At `orchestration.start`, it derives a worker skill policy server-side and snapshots stable skill references into the run. Workers may activate only skills in that snapshot. `skill.activate` and `skill.complete` are semantic lifecycle operations correlated to the run and recorded durably. Completion-only skill requirements are enforced at `work.settle`; objective evidence remains a separate requirement.

Skills contain reusable reasoning procedures. Tools and commands contain deterministic capabilities. Workers compose skills and tools. Workflows and the control plane own state transitions, retries, leases, and settlement.

## Initial policy

`Repository Implementation` requires `verification-before-completion` before a completed settlement. It may use `brainstorming`, `writing-plans`, `test-driven-development`, `systematic-debugging`, and `requesting-code-review`.

Workers without a configured skill policy receive an explicit empty policy and retain current behavior.

## Implementation slices

1. Derive and persist a run-level skill policy from the canonical worker identity. Do not accept a caller-authored policy.
2. Add durable skill activations with idempotent activate/complete behavior and resumable state projection.
3. Add semantic `skill.activate` and `skill.complete` worker commands that use the pinned run policy.
4. Gate `disposition=completed` settlement on completion of required skills. Requeue and blocked settlement remain available.
5. Include skill state in run/resume context and regression verification.

## Acceptance

- A run gets a server-derived immutable policy with stable skill revisions.
- Unknown or forbidden skill activation fails closed.
- Activation completion is idempotent.
- Resume state reports active, completed, and remaining required skills.
- Completed settlement without a required skill returns `SKILL_REQUIREMENT_UNSATISFIED`.
- Requeue and blocked settlements are not prevented by completion-only skill gates.
- Existing workers with no required skill policy remain compatible.
- Exact-head regression verification is green before integration.