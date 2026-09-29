import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GITHUB_COMMIT_STATUS_EFFECT,
  GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
  GITHUB_SOURCE_INTEGRATION_EFFECT,
} from '../src/effect-adapter.ts';
import { createTypeScriptFunctionEffectProbe } from '../scripts/typescript-effect-reachability.ts';
import {
  explicitGitHubActionsWritePermissions,
  observeGitHubActionsSources,
} from '../src/observation/github-actions-capabilities.ts';
import {
  observeGitHubActionsProviderEffects,
  recognizedGitHubActionsProviderEffects,
} from '../src/observation/github-actions-effects.ts';
import { workflowTypeScriptEntrypoints } from '../src/observation/workflow-transitive-effects.ts';

const revision = 'a'.repeat(40);

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

test('workflow TypeScript entrypoints are observed without treating npm scripts as direct entrypoints', () => {
  const source = `steps:
  - run: node --experimental-strip-types src/cli/project-submit.ts --receipt out.json
  - run: npm run test
`;
  assert.deepEqual(workflowTypeScriptEntrypoints(source), [
    { entrypoint: 'src/cli/project-submit.ts', line_number: 2 },
  ]);
});

test('function-level effect reachability ignores imported but uncalled mutation APIs', () => {
  const probe = createTypeScriptFunctionEffectProbe(process.cwd());
  try {
    assert.deepEqual(probe('test/fixtures/function-effect-import-only.ts'), {
      effects: [],
      unresolved_calls: [],
    });
  } finally {
    probe.dispose?.();
  }
});

test('function-level effect reachability binds called semantic mutation terminals', () => {
  const probe = createTypeScriptFunctionEffectProbe(process.cwd());
  try {
    const analysis = probe('test/fixtures/function-effect-called.ts');
    assert.deepEqual(analysis.unresolved_calls, []);
    assert.deepEqual(
      analysis.effects.map((fact) => ({
        effect: fact.effect,
        terminal: `${fact.terminal_path}#${fact.terminal_symbol}`,
        root: fact.call_chain[0],
        leaf: fact.call_chain.at(-1),
        digest_length: fact.terminal_statement_sha256.length,
      })),
      [
        {
          effect: GITHUB_COMMIT_STATUS_EFFECT,
          terminal: 'src/providers/github/status-effect.ts#performGitHubCommitStatusEffect',
          root: 'test/fixtures/function-effect-called.ts#<module>',
          leaf: 'src/providers/github/status-effect.ts#performGitHubCommitStatusEffect',
          digest_length: 64,
        },
        {
          effect: GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
          terminal:
            'src/providers/github/pr-update-branch-effect.ts#performGitHubPullRequestUpdateBranchEffect',
          root: 'test/fixtures/function-effect-called.ts#<module>',
          leaf: 'src/providers/github/pr-update-branch-effect.ts#performGitHubPullRequestUpdateBranchEffect',
          digest_length: 64,
        },
        {
          effect: GITHUB_SOURCE_INTEGRATION_EFFECT,
          terminal: 'src/source/source-integration.ts#integrateVerifiedSourceCandidate',
          root: 'test/fixtures/function-effect-called.ts#<module>',
          leaf: 'src/source/source-integration.ts#integrateVerifiedSourceCandidate',
          digest_length: 64,
        },
      ],
    );
  } finally {
    probe.dispose?.();
  }
});

test('real operator entrypoints do not inherit uncalled GitHub HTTP effects', () => {
  const probe = createTypeScriptFunctionEffectProbe(process.cwd());
  try {
    for (const entrypoint of ['src/cli/project-advance.ts', 'src/cli/project-submit.ts']) {
      const analysis = probe(entrypoint);
      assert.equal(
        analysis.unresolved_calls.some((fact) => fact.candidate_effects.length > 0),
        false,
      );
      assert.equal(
        analysis.effects.some(
          (fact) =>
            fact.effect === GITHUB_COMMIT_STATUS_EFFECT ||
            fact.effect === GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
        ),
        false,
      );
    }
  } finally {
    probe.dispose?.();
  }
});

test('inline higher-order callbacks resolve through actual argument bindings', () => {
  const probe = createTypeScriptFunctionEffectProbe(process.cwd());
  try {
    assert.deepEqual(probe('test/fixtures/function-effect-callback.ts'), {
      effects: [],
      unresolved_calls: [],
    });
  } finally {
    probe.dispose?.();
  }
});

test('effect calls inside inline callbacks remain reachable', () => {
  const probe = createTypeScriptFunctionEffectProbe(process.cwd());
  try {
    const analysis = probe('test/fixtures/function-effect-callback-effect.ts');
    assert.deepEqual(analysis.unresolved_calls, []);
    assert.deepEqual(
      analysis.effects.map((fact) => fact.effect),
      [GITHUB_COMMIT_STATUS_EFFECT],
    );
    assert.equal(
      analysis.effects[0]?.call_chain.some((entry) =>
        entry.includes('function-effect-callback-effect.ts#<anonymous>'),
      ),
      true,
    );
  } finally {
    probe.dispose?.();
  }
});

test('interface dispatch becomes explicit unresolved dynamic target', () => {
  const probe = createTypeScriptFunctionEffectProbe(process.cwd());
  try {
    const analysis = probe('test/fixtures/function-effect-interface.ts');
    assert.deepEqual(analysis.effects, []);
    assert.equal(analysis.unresolved_calls.length, 1);
    assert.equal(
      analysis.unresolved_calls[0]?.call_site_path,
      'test/fixtures/function-effect-interface.ts',
    );
    assert.equal(analysis.unresolved_calls[0]?.declaration_symbol, 'plugin.run');
    assert.deepEqual(analysis.unresolved_calls[0]?.candidate_effects, []);
  } finally {
    probe.dispose?.();
  }
});

test('effect-bearing dynamic dispatch carries candidate effect families', () => {
  const probe = createTypeScriptFunctionEffectProbe(process.cwd());
  try {
    const analysis = probe('test/fixtures/function-effect-dynamic-effect.ts');
    assert.deepEqual(analysis.effects, []);
    assert.equal(analysis.unresolved_calls.length, 1);
    assert.deepEqual(analysis.unresolved_calls[0]?.candidate_effects, [
      GITHUB_COMMIT_STATUS_EFFECT,
    ]);
  } finally {
    probe.dispose?.();
  }
});
