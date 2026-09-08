import assert from 'node:assert/strict';
import test from 'node:test';

import { classifiedActivationExitCode } from './cloud-run-target-activation-exit.mjs';

test('activation exit codes preserve operational PostgreSQL and connection failure classes', () => {
  assert.equal(classifiedActivationExitCode({ code:'42501' }), 13);
  assert.equal(classifiedActivationExitCode({ code:'55000' }), 14);
  assert.equal(classifiedActivationExitCode({ code:'TARGET_ACTIVATION_DEPENDENCY_MISMATCH' }), 15);
  assert.equal(classifiedActivationExitCode({ code:'POSTGRES_CONFIG_REQUIRED' }), 16);
  assert.equal(classifiedActivationExitCode({ code:'ENOENT' }), 17);
  assert.equal(classifiedActivationExitCode({ code:'ECONNREFUSED' }), 18);
  assert.equal(classifiedActivationExitCode({ code:'ENOTFOUND' }), 19);
  assert.equal(classifiedActivationExitCode({ code:'ETIMEDOUT' }), 20);
  assert.equal(classifiedActivationExitCode({ code:'25006' }), 21);
  assert.equal(classifiedActivationExitCode({ code:'28P01' }), 22);
  assert.equal(classifiedActivationExitCode({ code:'3D000' }), 23);
  assert.equal(classifiedActivationExitCode({ code:'42883' }), 24);
  assert.equal(classifiedActivationExitCode({ code:'42P01' }), 25);
  assert.equal(classifiedActivationExitCode({ code:'42704' }), 26);
  assert.equal(classifiedActivationExitCode({ code:'2BP01' }), 27);
  assert.equal(classifiedActivationExitCode({ code:'57P01' }), 28);
  assert.equal(classifiedActivationExitCode({ code:'08006' }), 29);
  assert.equal(classifiedActivationExitCode({ code:'08001' }), 30);
  assert.equal(classifiedActivationExitCode({ code:'53300' }), 31);
  assert.equal(classifiedActivationExitCode({ code:'SOMETHING_ELSE' }), 99);
  assert.equal(classifiedActivationExitCode(new Error('unknown')), 99);
});
