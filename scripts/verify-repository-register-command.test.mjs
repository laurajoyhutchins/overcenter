import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSuccess } from '../lib/command-response.js';

test('repository registration is an admitted canonical command', () => {
  const body = commandSuccess(
    'portfolio.repository_register',
    { ok: true, registered: true },
    { now: () => '2026-08-26T20:00:00.000Z' },
  );
  assert.equal(body.command, 'portfolio.repository_register');
  assert.equal(body.registered, true);
});