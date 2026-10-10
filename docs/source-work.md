# Source-change work

Source changes have a separate trust problem from pure output generation: a candidate commit must be bound to the exact claimed source and exact task, and integration must be justified by trusted evidence rather than by the producer's assertion.

The maintained primitives on `main` live under [`src/source/`](../src/source/).

## Source task contract

The current `overcenter-source-task/v1` contract requires `schema`, `kind`, `objective`, and a `writable_paths` array. It optionally accepts a `write_envelope`, an acceptance predicate, and task context. For example:

    {
      "schema": "overcenter-source-task/v1",
      "kind": "source-change",
      "objective": "...",
      "writable_paths": ["src/example.ts"]
    }

Exact `writable_paths` and an optional bounded `write_envelope` authorize the candidate's scope; the independently observed Git delta supplies the concrete changed paths. Envelope rules can allow roots, deny roots/paths, and set file/byte limits. Denials and repository-profile protected paths override allowances. The trusted verifier profile comes from the claimed base, not candidate-authored bytes.

Path entries must be safe repository-relative paths. Absolute paths, traversal components, `.git`, Windows drive prefixes, and duplicates are rejected. Source admission fails closed when no valid writable scope remains.

A source candidate is bound to:

- the exact obligation key;
- the exact run;
- the claimed authority revision;
- the claimed source SHA;
- the candidate commit SHA.

Changing any binding invalidates the candidate rather than silently rebasing its meaning.

## GitHub workflow evidence admission

[`src/source/github-evidence-admission.ts`](../src/source/github-evidence-admission.ts) provides one narrow admission primitive for a frozen source task.

It accepts the task only when canonical GitHub observations establish that:

1. the task file exists in the exact design commit;
2. the named workflow run completed successfully at that same commit;
3. the named workflow job belongs to that run and attempt;
4. the job completed successfully; and
5. the job name is exactly `promote:<task-path>`.

The design commit therefore freezes both the proposed task bytes and the experiment/evaluation machinery used to authorize promotion.

## Boundary on current `main`

This evidence-admission primitive does not, by itself, make arbitrary source candidates authoritative or provide a complete end-to-end source-change product loop. Candidate execution, current-main verification, conflict handling, and integration remain separate authority steps and must not be inferred from a successful promotion workflow alone.

The source producer proposes bytes. Trusted machinery owns admission, fresh-source verification, and integration.
