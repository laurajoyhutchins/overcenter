# Semantic scaling falsification

This experiment asks whether Overcenter can govern increasingly semantic work without making the trusted authority path reproduce the same task-specific reasoning as the worker.

The hypothesis is deliberately falsifiable:

> As autonomous work becomes more semantically complex and consequential, the authority-bearing mechanism required to prevent false settlement can remain substantially smaller and more task-independent than the reasoning machinery that proposes the work.

The experiment does **not** treat raw repository size as the result. Existing property-scoped TCB measurement remains the source for trusted-surface size. This experiment adds semantic attribution: whether trusted machinery is reused and general, newly reusable, provider-specific, or task-specific, and whether any task-specific trusted rule is effectively equivalent to the candidate-producing judgment.

The preregistered classification has four outcomes:

- **convergent** — the authoritative claim is mechanically settleable without reproducing candidate reasoning or narrowing the claim;
- **frontier-limited** — the kernel remains mechanical by settling a narrower claim and retaining the residual semantic judgment explicitly;
- **semantic-mirroring** — trusted authority-bearing logic reproduces substantially the same task-specific judgment used to construct the candidate;
- **unsupported** — the requested truth cannot be established from the declared observation/authority assumptions.

`fixtures.json` contains synthetic controls across five rungs. They are not empirical evidence that the scaling thesis holds. In particular, `mirrored-bug-repair-negative-control` is intentionally bad architecture and must classify as semantic mirroring. `weakly-observable-external-effect` must remain unsupported rather than becoming terminal merely because more deterministic machinery is added.

Run:

```sh
npm run test:semantic-scaling
npm run experiment:semantic-scaling
```

The CLI emits a deterministic comparison artifact to stdout. Surface order does not affect the result.

## Promotion boundary

This experiment is pending. A positive research claim requires real tasks from materially different families, exact revision-bound property-scoped TCB attribution, observation-support evidence, and the constant hostile controls described in issue #460. Synthetic fixtures exist only to prove that the measurement vocabulary can distinguish the intended outcomes, including a known failure.

The anti-cheating question for every new trusted task-specific rule is:

> Why can this not instead be supplied as untrusted evidence checked by an existing or more general trusted primitive?

Moving semantic logic into a provider adapter, generated artifact, policy file, proof generator, or test harness does not remove it from the trusted surface when settlement depends on that logic being correct.
