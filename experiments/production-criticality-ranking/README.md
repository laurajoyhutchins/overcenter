# Hostile mutation evidence (maintained)

This directory retains the **exact-blob-bound production mutation probes** used by the TCB report and workflows. Its older production-*callable* importance analyzer has been retired: `analyze.ts` and `analyze.test.ts` are not present in the accepted source tree, and the corresponding legacy ranking config is no longer executable.

The historic quantitative ranking question, calibration and outcome remain available at the exact [pre-retirement source revision](https://github.com/laurajoyhutchins/overcenter/blob/2d7ddea66638564fa8b6fc30e9a690329d26e8ac/experiments/production-criticality-ranking/README.md). Its last registered evaluated revision was `515a771257ca0ac21cede5410144be5e02da4f7b` (GitHub Actions run `35673456200`). That historical result is **not** an active deletion-admission authority.

The surviving workload has different semantics: `mutation-probes.json` selects bounded production symbol ranges and their tests; `resolve-mutation-probes.ts` fails on missing or ambiguous symbols; `mutation-evidence.json` records historical mutation evidence and source-blob bindings; verifier scripts reject misbound source evidence. Never treat stale mutation evidence as fresh.

Run the maintained local checks with:

```sh
node --experimental-strip-types --test experiments/production-criticality-ranking/mutation-evidence.test.ts
node --experimental-strip-types --test experiments/production-criticality-ranking/verify-mutation-evidence.test.ts
npm run check:tcb
```

The experiment registry describes only maintained experiments. The old callable-analysis entry was removed because its documented reproducer referenced absent files; the mutation evidence is retained because it remains a separate assurance input.

For the full archival file list and rationale, see [retired artifact lineage](../../docs/retired-artifact-lineage.md).
