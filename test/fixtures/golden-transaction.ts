/**
 * Golden transaction shared by semantic planning and lifecycle regressions.
 *
 * The planner starts from semantic_intent and must derive expected_write_set.
 * The lifecycle starts from the candidate edit and must observe the expected
 * staged delta before deriving assurance impact and minimum evidence.
 */
export const GOLDEN_TRANSACTION_CASE = {
  id: 'github-status-description',
  semantic_intent:
    'Change only the descriptive text attached to the trusted GitHub commit-status mutation.',
  expected_write_set: ['src/providers/github/status-effect.ts'],
  candidate: {
    path: 'src/providers/github/status-effect.ts',
    before: "description: 'Overcenter trusted effect broker',",
    after: "description: 'Overcenter trusted commit-status effect broker',",
  },
  expected_staged_delta: ['src/providers/github/status-effect.ts'],
  expected_assurance_impacts: [
    {
      property_id: 'github-commit-status-provider',
      changed_artifacts: ['src/providers/github/status-effect.ts'],
      direct: true,
      via_properties: [],
    },
  ],
  expected_minimum_evidence: [
    {
      evidence_id: 'effect-core-loop-proof',
      obligation_ids: [
        'exact-revision-effect',
        'reserve-before-effect',
        'unresolved-effect-no-replay',
      ],
      artifact_ids: ['test/trusted-effect-core-loop.test.ts'],
    },
    {
      evidence_id: 'provider-observation-proof',
      obligation_ids: ['authoritative-settlement'],
      artifact_ids: ['test/provider-observation.test.ts'],
    },
  ],
} as const;
