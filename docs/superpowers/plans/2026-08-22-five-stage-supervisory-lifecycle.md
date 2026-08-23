# Five-Stage Supervisory Lifecycle Implementation Plan

> Required execution procedure: test-driven-development, then verification-before-completion before settling the work item.

## Task 1: Canonical lifecycle kernel

Create `lib/work-lifecycle.js` with the five productive stages, four off-nominal conditions plus NOMINAL, stage command names, the deterministic earliest-unsatisfied-responsibility resolver, fresh recovery resolution, and projection-only legacy lane mapping. Register and run `lib/work-lifecycle.test.js` with exhaustive twenty-transition coverage.

## Task 2: Remove worker-selected successor routing

Update the work settlement boundary so callers report lifecycle facts/evidence rather than `next_state` and `next_lane`. Resolve the successor with the lifecycle kernel. Preserve idempotency, exact-state fencing, continuation evidence, repository disposition checks, and settlement receipts.

## Task 3: Bind scheduled executors to stages

Expose stage identity from the scheduled participant registry and context. Rename/reorder the five scheduled tasks to Enable, Acquire, Execute, Commit, Confirm after the deployed runtime accepts the stage model. Keep current participant IDs only where they are opaque scheduler identities, not lifecycle authority.

## Task 4: Verify and integrate

Run canonical regression verification, lifecycle-focused regressions, scheduled-context regressions, and exact-head review. Open a focused PR, resolve review/check failures, merge under exact-head protection, deploy the merged source, verify the production regression endpoint, and settle the Busbar work item with exact evidence.
