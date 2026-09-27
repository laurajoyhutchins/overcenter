import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ARCHITECTURE_INTENT_SCHEMA,
  architectureReconciliationWork,
  type ArchitectureIntent,
  type ArchitectureObservedFact,
  reconcileArchitecture,
  validateArchitectureIntent,
} from '../src/authority/architecture-reconciliation.ts';
import { classifyJudgmentFrontier } from '../src/authority/judgment-frontier.ts';
import type { ProjectExplanation } from '../src/authority/project-state.ts';
import type { Work } from '../src/model.ts';
import { observeArchitectureIntent } from '../scripts/observe-architecture.ts';
import {
  explicitGitHubActionsWritePermissions,
  observeGitHubActionsSources,
} from '../src/observation/github-actions-capabilities.ts';
import {
  observeGitHubActionsProviderEffects,
  recognizedGitHubActionsProviderEffects,
} from '../src/observation/github-actions-effects.ts';

const revision = 'a'.repeat(40);

function intent(): ArchitectureIntent {
  return {
    schema: ARCHITECTURE_INTENT_SCHEMA,
    claims: [
      {
        kind: 'authority-role',
        concept: 'fixture',
        authority: 'src/authority.ts',
        projections: ['src/view.ts'],
        verifiers: ['test/authority.test.ts'],
      },
    ],
  };
}

function observations(
  overrides: Partial<
    Record<'authority' | 'projection' | 'verifier' | 'forward' | 'reverse', boolean>
  > = {},
): ArchitectureObservedFact[] {
  return [
    {
      kind: 'path-state',
      source_revision: revision,
      path: 'src/authority.ts',
      present: overrides.authority ?? true,
    },
    {
      kind: 'path-state',
      source_revision: revision,
      path: 'src/view.ts',
      present: overrides.projection ?? true,
    },
    {
      kind: 'path-state',
      source_revision: revision,
      path: 'test/authority.test.ts',
      present: overrides.verifier ?? true,
    },
    {
      kind: 'typescript-reference-state',
      source_revision: revision,
      from_path: 'src/authority.ts',
      to_path: 'src/view.ts',
      present: overrides.forward ?? false,
    },
    {
      kind: 'typescript-reference-state',
      source_revision: revision,
      from_path: 'src/view.ts',
      to_path: 'src/authority.ts',
      present: overrides.reverse ?? true,
    },
  ];
}

test('maintained architecture intent reconciles against observed production flow', () => {
  const maintained = validateArchitectureIntent(
    JSON.parse(readFileSync('.overcenter/architecture-intent.json', 'utf8')),
  );
  const observed = observeArchitectureIntent(maintained, revision);
  const result = reconcileArchitecture({
    intent: maintained,
    source_revision: revision,
    observations: observed,
  });
  assert.equal(
    result.resolutions.every((resolution) => resolution.state === 'established'),
    true,
  );
});

test('agreement is established only from exact-revision observations', () => {
  const result = reconcileArchitecture({
    intent: intent(),
    source_revision: revision,
    observations: observations(),
  });
  assert.equal(result.resolutions.length, 1);
  assert.equal(result.resolutions[0]?.state, 'established');

  const stale = observations();
  stale[0] = { ...stale[0]!, source_revision: 'b'.repeat(40) };
  assert.throws(
    () =>
      reconcileArchitecture({
        intent: intent(),
        source_revision: revision,
        observations: stale,
      }),
    /ARCHITECTURE_OBSERVATION_REVISION_MISMATCH/,
  );
});

test('declared authority cannot override an observed missing path', () => {
  const result = reconcileArchitecture({
    intent: intent(),
    source_revision: revision,
    observations: observations({ authority: false }),
  });
  const resolution = result.resolutions[0]!;
  assert.equal(resolution.state, 'conflict');
  if (resolution.state !== 'conflict') return;
  assert.equal(resolution.reason_code, 'AUTHORITY_PATH_MISSING');
  assert.equal(resolution.contradicting_facts[0]?.kind, 'path-state');
});

test('missing observation coverage stays unknown instead of becoming false certainty', () => {
  const incomplete = observations().filter(
    (fact) =>
      !(
        fact.kind === 'typescript-reference-state' &&
        fact.from_path === 'src/view.ts' &&
        fact.to_path === 'src/authority.ts'
      ),
  );
  const forward = incomplete.find(
    (fact) =>
      fact.kind === 'typescript-reference-state' &&
      fact.from_path === 'src/authority.ts' &&
      fact.to_path === 'src/view.ts',
  );
  if (forward?.kind === 'typescript-reference-state') forward.present = false;

  const result = reconcileArchitecture({
    intent: intent(),
    source_revision: revision,
    observations: incomplete,
  });
  const resolution = result.resolutions[0]!;
  assert.equal(resolution.state, 'unknown');
  if (resolution.state !== 'unknown') return;
  assert.deepEqual(resolution.missing_evidence, [
    'typescript-reference-state:src/view.ts->src/authority.ts',
  ]);
});

test('observed disagreement becomes bounded reasoning work with no mutation authority', () => {
  const result = reconcileArchitecture({
    intent: intent(),
    source_revision: revision,
    observations: observations({ forward: false, reverse: false }),
  });
  const resolution = result.resolutions[0]!;
  assert.equal(resolution.state, 'conflict');
  if (resolution.state !== 'conflict') return;
  assert.equal(resolution.reason_code, 'DECLARED_PROJECTION_FLOW_MISSING');

  const obligation = architectureReconciliationWork(resolution, revision);
  const work: Work = {
    ...obligation,
    dependencies: obligation.dependencies ?? [],
    packet: obligation.packet ?? {},
    status: 'BLOCKED',
    revision,
    blocked_reason: 'JUDGMENT_REQUIRED',
  };
  const explanation: ProjectExplanation = {
    obligation_id: work.id,
    status: 'BLOCKED',
    reason: {
      kind: 'judgment-required',
      subject:
        work.postcondition.verifier === 'operator-judgment/v1' ? work.postcondition.subject : {},
    },
  };
  const dispatch = classifyJudgmentFrontier({
    work,
    explanation,
    unresolved_effect: false,
  });
  assert.equal(dispatch.route, 'reasoning-required');
  assert.equal(dispatch.reason_code, 'ARCHITECTURE_RECONCILIATION_REQUIRED');
  assert.ok(dispatch.evidence_predicates.includes('packet.kind=architecture-reconciliation'));
});

test('duplicate authority ownership is a conflict rather than silently accepted reality', () => {
  const duplicated: ArchitectureIntent = {
    schema: ARCHITECTURE_INTENT_SCHEMA,
    claims: [
      {
        kind: 'authority-role',
        concept: 'first',
        authority: 'src/shared.ts',
        projections: [],
        verifiers: [],
      },
      {
        kind: 'authority-role',
        concept: 'second',
        authority: 'src/shared.ts',
        projections: [],
        verifiers: [],
      },
    ],
  };
  const result = reconcileArchitecture({
    intent: duplicated,
    source_revision: revision,
    observations: [
      {
        kind: 'path-state',
        source_revision: revision,
        path: 'src/shared.ts',
        present: true,
      },
    ],
  });
  assert.deepEqual(
    result.resolutions.map((resolution) =>
      resolution.state === 'conflict' ? resolution.reason_code : resolution.state,
    ),
    ['DUPLICATE_AUTHORITY_OWNER', 'DUPLICATE_AUTHORITY_OWNER'],
  );
});

test('GitHub Actions observer finds explicit write grants without inferring inherited writes', () => {
  const source = `
permissions:
  contents: read
jobs:
  publish:
    permissions:
      contents: write
      statuses: read
  propose:
    permissions: { pull-requests: write, contents: read }
  broad:
    permissions: write-all
`;
  assert.deepEqual(explicitGitHubActionsWritePermissions(source), [
    '*',
    'contents',
    'pull-requests',
  ]);

  const observed = observeGitHubActionsSources(
    {
      '.github/workflows/inherited.yml': `jobs:
  publish:
    permissions:
      contents: write
`,
    },
    revision,
  );
  assert.equal(
    observed.some((fact) => fact.kind === 'github-actions-inherited-permissions'),
    true,
  );
  assert.equal(
    observed.some(
      (fact) =>
        fact.kind === 'github-actions-explicit-write-capability' &&
        fact.workflow_path === '.github/workflows/inherited.yml' &&
        fact.permission === 'contents',
    ),
    true,
  );
});

test('undeclared GitHub Actions write capability becomes an architecture conflict', () => {
  const policy: ArchitectureIntent = {
    schema: ARCHITECTURE_INTENT_SCHEMA,
    claims: [
      {
        kind: 'github-actions-explicit-write-authority',
        concept: 'workflow-write-authority',
        allowed: [
          {
            workflow: '.github/workflows/allowed.yml',
            permissions: ['contents'],
          },
        ],
      },
    ],
  };
  const observed = observeGitHubActionsSources(
    {
      '.github/workflows/allowed.yml': `permissions:
  contents: write
`,
      '.github/workflows/rogue.yml': `permissions:
  statuses: write
`,
    },
    revision,
  );
  const result = reconcileArchitecture({
    intent: policy,
    source_revision: revision,
    observations: observed,
  });
  const resolution = result.resolutions[0]!;
  assert.equal(resolution.state, 'conflict');
  if (resolution.state !== 'conflict') return;
  assert.equal(resolution.reason_code, 'UNDECLARED_GITHUB_ACTIONS_EXPLICIT_WRITE_CAPABILITY');
  assert.deepEqual(
    resolution.contradicting_facts.map((fact) =>
      fact.kind === 'github-actions-explicit-write-capability'
        ? `${fact.workflow_path}:${fact.permission}`
        : fact.kind,
    ),
    ['.github/workflows/rogue.yml:statuses'],
  );
});

test('GitHub Actions write policy stays unknown when workflow scan evidence is absent', () => {
  const policy: ArchitectureIntent = {
    schema: ARCHITECTURE_INTENT_SCHEMA,
    claims: [
      {
        kind: 'github-actions-explicit-write-authority',
        concept: 'workflow-write-authority',
        allowed: [
          {
            workflow: '.github/workflows/allowed.yml',
            permissions: ['contents'],
          },
        ],
      },
    ],
  };
  const result = reconcileArchitecture({
    intent: policy,
    source_revision: revision,
    observations: [],
  });
  const resolution = result.resolutions[0]!;
  assert.equal(resolution.state, 'unknown');
  if (resolution.state !== 'unknown') return;
  assert.deepEqual(resolution.missing_evidence, ['github-actions-workflow-scan']);
});

test('GitHub Actions effect observer recognizes direct provider mutations only', () => {
  const source = `
steps:
  - run: git push origin HEAD:refs/heads/topic
  - run: git push --quiet origin ":refs/heads/obsolete"
  - run: api_post "/repos/\${REPOSITORY}/git/blobs" "{}"
  - run: api_post "/repos/\${REPOSITORY}/git/trees" "{}"
  - run: api_post "/repos/\${REPOSITORY}/git/commits" "{}"
  - run: api_post "/repos/\${REPOSITORY}/git/refs" "{}"
  - run: |
      curl --request POST \
        "https://api.github.com/repos/$REPOSITORY/statuses/$SOURCE_SHA"
  - run: |
      curl -X POST \
        "https://api.github.com/repos/$REPOSITORY/pulls"
  - run: curl "https://api.github.com/repos/$REPOSITORY/pulls/123"
`;
  assert.deepEqual(
    recognizedGitHubActionsProviderEffects(source).map((fact) => fact.effect),
    [
      'github-git-ref/update',
      'github-git-ref/delete',
      'github-git-blob/create',
      'github-git-tree/create',
      'github-git-commit/create',
      'github-git-ref/create',
      'github-commit-status/create',
      'github-pull-request/create',
    ],
  );
});

test('provider effect observations are exact-source facts with statement digests', () => {
  const observed = observeGitHubActionsProviderEffects(
    {
      '.github/workflows/publish.yml': `jobs:
  publish:
    steps:
      - run: git push origin HEAD:main
`,
    },
    revision,
  );
  assert.equal(observed.length, 1);
  assert.deepEqual(
    {
      kind: observed[0]?.kind,
      revision: observed[0]?.source_revision,
      workflow: observed[0]?.workflow_path,
      effect: observed[0]?.effect,
      line: observed[0]?.line_number,
      digest_length: observed[0]?.statement_sha256.length,
    },
    {
      kind: 'github-actions-provider-effect-invocation',
      revision,
      workflow: '.github/workflows/publish.yml',
      effect: 'github-git-ref/update',
      line: 4,
      digest_length: 64,
    },
  );
});

test('undeclared direct provider effect becomes architecture reconciliation work', () => {
  const policy: ArchitectureIntent = {
    schema: ARCHITECTURE_INTENT_SCHEMA,
    claims: [
      {
        kind: 'github-actions-provider-effect-authority',
        concept: 'workflow-provider-effects',
        allowed: [
          {
            workflow: '.github/workflows/allowed.yml',
            effects: ['github-git-ref/update'],
          },
        ],
      },
    ],
  };
  const sources = {
    '.github/workflows/allowed.yml': `steps:
  - run: git push origin HEAD:main
`,
    '.github/workflows/rogue.yml': `steps:
  - run: |
      curl -X POST "https://api.github.com/repos/$GITHUB_REPOSITORY/pulls"
`,
  };
  const observed: ArchitectureObservedFact[] = [
    ...observeGitHubActionsSources(sources, revision),
    ...observeGitHubActionsProviderEffects(sources, revision),
  ];
  const result = reconcileArchitecture({
    intent: policy,
    source_revision: revision,
    observations: observed,
  });
  const resolution = result.resolutions[0]!;
  assert.equal(resolution.state, 'conflict');
  if (resolution.state !== 'conflict') return;
  assert.equal(resolution.reason_code, 'UNDECLARED_GITHUB_ACTIONS_PROVIDER_EFFECT');
  assert.deepEqual(
    resolution.contradicting_facts.map((fact) =>
      fact.kind === 'github-actions-provider-effect-invocation'
        ? `${fact.workflow_path}:${fact.effect}`
        : fact.kind,
    ),
    ['.github/workflows/rogue.yml:github-pull-request/create'],
  );

  const work = architectureReconciliationWork(resolution, revision);
  assert.equal(work.packet?.kind, 'architecture-reconciliation');
  assert.equal(work.postcondition.verifier, 'operator-judgment/v1');
});

test('effect invocation is observed even when write capability is absent', () => {
  const source = `permissions:
  contents: read
steps:
  - run: |
      curl --request POST \
        "https://api.github.com/repos/$REPOSITORY/statuses/$SOURCE_SHA"
`;
  assert.deepEqual(explicitGitHubActionsWritePermissions(source), []);
  assert.deepEqual(
    recognizedGitHubActionsProviderEffects(source).map((fact) => fact.effect),
    ['github-commit-status/create'],
  );
});
