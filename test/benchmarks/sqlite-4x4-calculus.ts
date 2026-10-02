import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FourByFourProjection } from '../../src/authority/effect-history-projection.ts';
import { SqliteFourByFourCalculus } from '../../src/authority/sqlite-calculus.ts';

const sources: FourByFourProjection['coordinates'][number]['sources'] = [
  { commit: 'benchmark-head', fact: 'claim' },
];

function projection(size: number, coordinateCount: number): FourByFourProjection {
  const coordinates = Array.from({ length: coordinateCount }, (_, index) => ({
    id: `c-${String(index).padStart(3, '0')}`,
    value: { revision: index },
    sources,
  }));
  const objects: FourByFourProjection['objects'] = [];
  const events: FourByFourProjection['events'] = [];
  const propositions: FourByFourProjection['propositions'] = [];
  const permits: FourByFourProjection['permits'] = [];
  const asserts: FourByFourProjection['asserts'] = [];

  for (let index = 0; index < size; index += 1) {
    const id = String(index).padStart(6, '0');
    const coordinate = `c-${String(index % coordinateCount).padStart(3, '0')}`;
    const reservation = `r-${id}`;
    objects.push({ id: `o-${id}`, coordinate, role: 'execution-authority', value: { index }, sources });
    events.push({ id: `e-${id}`, coordinate, role: 'effect-attempt', value: { reservation_commit: reservation }, sources });
    propositions.push({ id: `p-${id}`, coordinate, role: 'receipt', value: { index }, sources });
    permits.push({ id: `permit-${id}`, object: `o-${id}`, event: `e-${id}`, sources });
    if (index % 3 === 0) asserts.push({ id: `assert-${id}`, event: `e-${id}`, proposition: `p-${id}`, sources });
  }

  return { coordinates, objects, events, propositions, permits, asserts, supports: [], requires: [] };
}

function referencePermitted(value: FourByFourProjection, coordinate: string): string[] {
  const permitted = new Set(value.permits.map((edge) => edge.event));
  return value.events
    .filter((event) => event.coordinate === coordinate && permitted.has(event.id))
    .map((event) => event.id)
    .sort();
}

const size = 5000;
const coordinateCount = 64;
const iterations = 40;
const target = 'c-000';
const value = projection(size, coordinateCount);
const root = mkdtempSync(join(tmpdir(), 'sqlite-4x4-bench-'));
const database = join(root, 'overcenter.sqlite');

try {
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE authority(singleton INTEGER PRIMARY KEY CHECK(singleton=1), head TEXT, sequence INTEGER NOT NULL);
    INSERT INTO authority(singleton, head, sequence) VALUES(1, 'benchmark-head', 1);
  `);
  db.close();

  const calculus = new SqliteFourByFourCalculus(database);
  calculus.replaceProjection('benchmark-head', value);
  assert.deepEqual(calculus.permittedEvents(target).value, referencePermitted(value, target));

  for (let index = 0; index < 5; index += 1) {
    calculus.permittedEvents(target);
    referencePermitted(value, target);
  }

  let start = performance.now();
  for (let index = 0; index < iterations; index += 1) calculus.permittedEvents(target);
  const sqliteMs = performance.now() - start;

  start = performance.now();
  for (let index = 0; index < iterations; index += 1) referencePermitted(value, target);
  const typescriptMs = performance.now() - start;

  console.log(JSON.stringify({
    rows: size,
    coordinates: coordinateCount,
    iterations,
    sqlite_ms: Number(sqliteMs.toFixed(3)),
    typescript_ms: Number(typescriptMs.toFixed(3)),
    speedup: Number((typescriptMs / sqliteMs).toFixed(2)),
  }, null, 2));
  calculus.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}