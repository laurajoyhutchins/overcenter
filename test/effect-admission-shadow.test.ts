import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { KernelCore } from '../src/authority/engine.ts';
import {
  assertEffectAdmissionAgreement,
  effectPermitsFromProjection,
  shadowEffectAdmission,
  type EffectAdmissionShadowResult,
} from '../src/authority/effect-admission-shadow.ts';
import { SqliteFactStore } from '../src/storage/sqlite.ts';
import type { ExecutionPermit } from '../src/model.ts';

function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `4x4-admission-${name}-`));
  const store = new SqliteFactStore(join(root, 'overcenter.sqlite'));
  const kernel = new KernelCore(store);
  const initial = kernel.initialize();
  const revision = kernel.define({
    id: 'effect',
    packet: {},
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: join(root, 'effect.txt'),
      content: 'done',
    },
  });
  const permit = kernel.claim('effect', revision);
  const history = () => store.history(kernel.head()!);
  return {
    root,
    store,
    kernel,
    initial,
    permit,
    history,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function flipped(
  result: EffectAdmissionShadowResult,
  field: 'legacy' | 'permits',
): EffectAdmissionShadowResult {
  return { ...result, [field]: !result[field] };
}

test('current exact authority is admitted by both legacy and 4x4 permits', () => {
  const f = fixture('current');
  try {
    const result = shadowEffectAdmission(f.history(), f.permit);
    assert.equal(result.legacy, true);
    assert.equal(result.permits, true);
    assert.deepEqual(result.projected_state, result.legacy_state);
  } finally {
    f.close();
  }
});

test('stale generation and reacquired authority agree across both paths', () => {
  const f = fixture('reacquire');
  try {
    const reacquired = f.kernel.acquireExecution(f.permit.id);
    assert.equal(shadowEffectAdmission(f.history(), f.permit).legacy, false);
    const current = shadowEffectAdmission(f.history(), reacquired);
    assert.equal(current.legacy, true);
    assert.equal(current.permits, true);
    assert.deepEqual(current.projected_state, current.legacy_state);
  } finally {
    f.close();
  }
});

test('stale claim commit and obligation key are denied by the projected coordinate', () => {
  const f = fixture('exact-revision');
  try {
    for (const permit of [
      { ...f.permit, claimed_revision: 'stale-revision' },
      { ...f.permit, claim_commit: 'stale-claim' },
      { ...f.permit, obligation_key: 'stale-obligation-key' },
    ] satisfies ExecutionPermit[]) {
      const result = shadowEffectAdmission(f.history(), permit);
      assert.equal(result.legacy, false);
      assert.equal(result.permits, false);
      assert.equal(result.projected_state.exact_revision, false);
    }
  } finally {
    f.close();
  }
});

test('an unresolved reservation denies duplicate and reacquired effect admission', () => {
  const f = fixture('unresolved');
  try {
    f.kernel.beginEffect(f.permit);
    let result = shadowEffectAdmission(f.history(), f.permit);
    assert.equal(result.legacy, false);
    assert.equal(result.permits, false);
    assert.equal(result.projected_state.unresolved_effect, true);
    assert.throws(() => f.kernel.beginEffect(f.permit), /UNRESOLVED_EFFECT/);

    const reacquired = f.kernel.acquireExecution(f.permit.id);
    result = shadowEffectAdmission(f.history(), reacquired);
    assert.equal(result.legacy, false);
    assert.equal(result.permits, false);
    assert.equal(result.projected_state.current_authority, true);
    assert.equal(result.projected_state.unresolved_effect, true);
  } finally {
    f.close();
  }
});

test('crash-style recovery preserves unresolved denial after authority reacquisition', () => {
  const f = fixture('recovery');
  try {
    f.kernel.beginEffect(f.permit);
    f.kernel.recoverInterrupted(f.permit, { reason: 'worker-crash' });
    const reacquired = f.kernel.acquireExecution(f.permit.id);
    const result = shadowEffectAdmission(f.history(), reacquired);
    assert.equal(result.lifecycle_executing, true);
    assert.equal(result.legacy, false);
    assert.equal(result.permits, false);
    assert.equal(result.projected_state.unresolved_effect, true);
  } finally {
    f.close();
  }
});

test('independent runs preserve admission isolation under concurrent eligibility', () => {
  const root = mkdtempSync(join(tmpdir(), '4x4-admission-concurrency-'));
  const store = new SqliteFactStore(join(root, 'overcenter.sqlite'));
  const kernel = new KernelCore(store);
  try {
    kernel.initialize();
    kernel.define({
      id: 'a',
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: join(root, 'a.txt'),
        content: 'a',
      },
    });
    const revision = kernel.define({
      id: 'b',
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: join(root, 'b.txt'),
        content: 'b',
      },
    });
    const pa = kernel.claim('a', revision);
    const pb = kernel.claim('b', kernel.head()!);
    let history = store.history(kernel.head()!);
    assert.equal(shadowEffectAdmission(history, pa).permits, true);
    assert.equal(shadowEffectAdmission(history, pb).permits, true);

    kernel.beginEffect(pa);
    history = store.history(kernel.head()!);
    assert.equal(shadowEffectAdmission(history, pa).permits, false);
    assert.equal(shadowEffectAdmission(history, pb).permits, true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('bounded admission state exploration matches the formal reserve predicate', () => {
  for (const current_authority of [false, true]) {
    for (const exact_revision of [false, true]) {
      for (const unresolved_effect of [false, true]) {
        assert.equal(
          effectPermitsFromProjection({
            current_authority,
            exact_revision,
            unresolved_effect,
          }),
          current_authority && exact_revision && !unresolved_effect,
        );
      }
    }
  }
});

test('hostile mutation of either decision path is detected by the shadow comparator', () => {
  const f = fixture('hostile');
  try {
    const result = shadowEffectAdmission(f.history(), f.permit);
    assert.throws(
      () => assertEffectAdmissionAgreement(flipped(result, 'legacy')),
      /EFFECT_ADMISSION_SHADOW_DIVERGENCE/,
    );
    assert.throws(
      () => assertEffectAdmissionAgreement(flipped(result, 'permits')),
      /EFFECT_ADMISSION_SHADOW_DIVERGENCE/,
    );
  } finally {
    f.close();
  }
});
