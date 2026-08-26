import test from 'node:test';
import assert from 'node:assert/strict';
import { initialRepositoryDisposition } from '../lib/repository-registration-policy.js';

test('new unarchived repositories register dormant', () => {
  assert.equal(initialRepositoryDisposition({ archived: false, existingDisposition: null }), 'DORMANT');
});

test('new archived repositories register archived', () => {
  assert.equal(initialRepositoryDisposition({ archived: true, existingDisposition: null }), 'ARCHIVED');
});

test('existing lifecycle is preserved by registration observation', () => {
  assert.equal(initialRepositoryDisposition({ archived: false, existingDisposition: 'ACTIVE' }), 'ACTIVE');
  assert.equal(initialRepositoryDisposition({ archived: false, existingDisposition: 'MAINTENANCE' }), 'MAINTENANCE');
  assert.equal(initialRepositoryDisposition({ archived: false, existingDisposition: 'DORMANT' }), 'DORMANT');
});