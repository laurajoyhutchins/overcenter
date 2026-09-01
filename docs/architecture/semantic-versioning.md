# Semantic versioning boundary

**Status: Current architecture / contract**

Overcenter uses semantic versions as public compatibility coordinates for released source. A version does not replace exact Git revision identity, project authority coordinates, verification evidence, or release receipts.

This document defines which kinds of change are inside Overcenter's semantic-versioning public API boundary. It does not assign a version bump to individual project transitions and it does not publish releases.

## Public compatibility surface

A change is SemVer-visible when it changes one of these externally consumable contracts:

- **Semantic commands.** Stable agent-facing or operator-facing command identities that callers are expected to invoke.
- **Semantic command contracts.** Documented request fields, response meaning, and other caller-visible behavior of those commands.
- **Project-definition schemas.** Repository-owned desired-state formats that users or tools author as Overcenter project input.
- **Project-horizon schemas.** Public milestone, release, project, transition, or portfolio target semantics consumed by callers.
- **Public evidence schemas.** Documented command-response, evidence, or receipt structures intended for external machine consumption.
- **External error semantics.** Stable error codes, classes, or recovery meanings on which callers are expected to branch.
- **Lifecycle semantics.** Publicly promised meanings of project transition states and the bounded execution lifecycle.

The TypeScript semantic kernel exposes the same classification as `SEMVER_PUBLIC_API_POLICY` in `src/semantic/semver-public-api.ts` so downstream release logic can depend on a typed boundary instead of reconstructing it from prose.

## Internal implementation surface

The following changes are not SemVer-visible by themselves when externally observable behavior remains compatible:

- internal file or module organization;
- PostgreSQL table, index, or migration layout that is not itself a documented external contract;
- Hatchable or other runtime-host implementation details;
- ports, adapters, provider plumbing, or dependency injection layout;
- behavior-preserving refactors.

An internal change becomes SemVer-visible when it also changes a public compatibility surface. Calling a change a refactor does not exempt a public behavior change from versioning.

## Compatibility judgment and deterministic release logic

The public API boundary answers a classification question: **can this change affect public compatibility?**

A reasoning agent may need to judge how an intended transition affects that boundary. Deterministic software should own the mechanical consequences of that judgment, including validating the declared impact, aggregating release impact, deriving a candidate version, fencing it to exact repository authority, and verifying the resulting release state.

Commit-message conventions may provide evidence or defaults, but they are not release authority. A caller should not choose an arbitrary final version when Overcenter can derive it from repository-owned release intent and the last verified release coordinate.

## Version is not identity

Keep these coordinates distinct:

```text
v0.9.0                  public compatibility coordinate
<exact Git SHA>         source identity
<horizon fingerprint>   release-scope identity
<verification receipt>  proof of verified effects
```

A semantic version may name a verified release, but execution fencing and recovery continue to use exact authority and evidence.

## Pre-1.0 policy

A pre-1.0 version does not imply a stable public API. Overcenter must not infer `1.0.0` merely because a transition is breaking. Declaring 1.0 stability is a separate repository-owned product decision.

Until a release policy explicitly says otherwise, this boundary only classifies compatibility surfaces. The release-impact and version-calculation contracts own bump semantics.