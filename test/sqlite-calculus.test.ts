import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { FourByFourProjection } from '../src/authority/effect-history-projection.ts';
import { SqliteFourByFourCalculus } from '../src/authority/sqlite-calculus.ts';

function durable(path: string, head = 'h1'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE authority (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      head TEXT,
      sequence INTEGER NOT NULL
    ) STRICT;
    INSERT INTO authority(singleton, head, sequence) VALUES(1, '${head}', 1);
    CREATE TABLE fact_commits(sequence INTEGER PRIMARY KEY, commit_id TEXT NOT NULL);
    INSERT INTO fact_commits(sequence, commit_id) VALUES(1, '${head}');
  `);
  return db;
}

const sources: FourByFourProjection['coordinates'][number]['sources'] = [
  { commit: 'h1', fact: 'claim' },
];

function projection(): FourByFourProjection {
  return {
    coordinates: [
      { id: 'c-authority', value: { run_id: 'run-1', execution_generation: 1 }, sources },
      {
        id: 'c-old',
        value: { run_id: 'run-1', execution_generation: 0, reservation_commit: 'r-old' },
        sources,
      },
      {
        id: 'c-open',
        value: { run_id: 'run-1', execution_generation: 1, reservation_commit: 'r-open' },
        sources,
      },
      {
        id: 'c-released',
        value: { run_id: 'run-1', execution_generation: 1, reservation_commit: 'r-released' },
        sources,
      },
      { id: 'c-requirements', value: { revision: 1 }, sources },
      { id: 'c-stale-proof', value: { revision: 0 }, sources },
    ],
    objects: [
      {
        id: 'o-authority',
        coordinate: 'c-authority',
        role: 'execution-authority',
        value: {},
        sources,
      },
      { id: 'o-proof', coordinate: 'c-requirements', role: 'evidence', value: {}, sources },
      { id: 'o-stale-proof', coordinate: 'c-stale-proof', role: 'evidence', value: {}, sources },
    ],
    events: [
      {
        id: 'e-old',
        coordinate: 'c-old',
        role: 'effect-attempt',
        value: { run_id: 'run-1', reservation_commit: 'r-old' },
        sources,
      },
      {
        id: 'e-open',
        coordinate: 'c-open',
        role: 'effect-attempt',
        value: { run_id: 'run-1', reservation_commit: 'r-open' },
        sources,
      },
      {
        id: 'e-release-receipt',
        coordinate: 'c-released',
        role: 'receipt',
        value: { kind: 'effect-not-dispatched' },
        sources,
      },
      {
        id: 'e-released',
        coordinate: 'c-released',
        role: 'effect-attempt',
        value: { run_id: 'run-1', reservation_commit: 'r-released' },
        sources,
      },
    ],
    propositions: [
      { id: 'p-a', coordinate: 'c-requirements', role: 'requirement', value: {}, sources },
      { id: 'p-b', coordinate: 'c-requirements', role: 'requirement', value: {}, sources },
      { id: 'p-c', coordinate: 'c-requirements', role: 'requirement', value: {}, sources },
      { id: 'p-goal', coordinate: 'c-requirements', role: 'goal', value: {}, sources },
      {
        id: 'p-not-dispatched',
        coordinate: 'c-released',
        role: 'not-dispatched',
        value: {},
        sources,
      },
    ],
    permits: [
      { id: 'permit-old', object: 'o-authority', event: 'e-old', sources },
      { id: 'permit-open', object: 'o-authority', event: 'e-open', sources },
      { id: 'permit-released', object: 'o-authority', event: 'e-released', sources },
    ],
    asserts: [
      {
        id: 'assert-release',
        event: 'e-release-receipt',
        proposition: 'p-not-dispatched',
        sources,
      },
    ],
    supports: [
      { id: 'support-a', object: 'o-proof', proposition: 'p-a', sources },
      { id: 'support-b-stale', object: 'o-stale-proof', proposition: 'p-b', sources },
    ],
    requires: [
      { id: 'requires-a', proposition: 'p-goal', required: 'p-a', sources },
      { id: 'requires-b', proposition: 'p-a', required: 'p-b', sources },
      { id: 'requires-c', proposition: 'p-b', required: 'p-c', sources },
      { id: 'requires-cycle', proposition: 'p-c', required: 'p-a', sources },
    ],
  };
}

function coordinateValue(value: FourByFourProjection, id: string) {
  return value.coordinates.find((row) => row.id === id)?.value;
}

function referencePermitted(value: FourByFourProjection, coordinate?: string): string[] {
  const permitted = new Set(value.permits.map((edge) => edge.event));
  return value.events
    .filter((event) => permitted.has(event.id))
    .filter((event) => coordinate === undefined || event.coordinate === coordinate)
    .map((event) => event.id)
    .sort();
}

function referenceRequirements(value: FourByFourProjection, root: string): string[] {
  const found = new Set<string>();
  const queue = value.requires
    .filter((edge) => edge.proposition === root)
    .map((edge) => edge.required);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === root || found.has(current)) continue;
    found.add(current);
    queue.push(
      ...value.requires.filter((edge) => edge.proposition === current).map((edge) => edge.required),
    );
  }
  return [...found].sort();
}

function referenceUnsupported(value: FourByFourProjection, root: string): string[] {
  const objects = new Map(value.objects.map((row) => [row.id, row]));
  const propositions = new Map(value.propositions.map((row) => [row.id, row]));
  const exactSupport = new Set(
    value.supports.flatMap((edge) => {
      const object = objects.get(edge.object);
      const proposition = propositions.get(edge.proposition);
      return object?.coordinate === proposition?.coordinate ? [edge.proposition] : [];
    }),
  );
  return referenceRequirements(value, root).filter((id) => !exactSupport.has(id));
}

function referenceStaleSupports(value: FourByFourProjection, currentCoordinate: string) {
  const objects = new Map(value.objects.map((row) => [row.id, row]));
  const propositions = new Map(value.propositions.map((row) => [row.id, row]));
  return value.supports
    .flatMap((edge) => {
      const object = objects.get(edge.object);
      const proposition = propositions.get(edge.proposition);
      if (!object || !proposition) return [];
      if (
        proposition.coordinate === currentCoordinate &&
        object.coordinate === proposition.coordinate
      )
        return [];
      return [
        {
          id: edge.id,
          object: edge.object,
          proposition: edge.proposition,
          object_coordinate: object.coordinate,
          proposition_coordinate: proposition.coordinate,
        },
      ];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function referenceStalePermissions(value: FourByFourProjection, currentCoordinate: string) {
  const events = new Map(value.events.map((row) => [row.id, row]));
  return value.permits
    .flatMap((edge) => {
      const event = events.get(edge.event);
      if (!event || event.coordinate === currentCoordinate) return [];
      return [
        { id: edge.id, object: edge.object, event: edge.event, event_coordinate: event.coordinate },
      ];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function referenceUnresolved(value: FourByFourProjection, coordinate?: string): string[] {
  const asserted = new Set(value.asserts.map((edge) => edge.proposition));
  const released = new Set(
    value.propositions
      .filter((item) => item.role === 'not-dispatched' && asserted.has(item.id))
      .flatMap((item) => {
        const reservation = coordinateValue(value, item.coordinate)?.reservation_commit;
        return typeof reservation === 'string' ? [reservation] : [];
      }),
  );
  const permitted = new Set(value.permits.map((edge) => edge.event));
  return value.events
    .filter((event) => event.role === 'effect-attempt' && permitted.has(event.id))
    .filter((event) => coordinate === undefined || event.coordinate === coordinate)
    .filter((event) => {
      const reservation = event.value.reservation_commit;
      return typeof reservation === 'string' && !released.has(reservation);
    })
    .map((event) => event.id)
    .sort();
}

function withCalculus(
  run: (calculus: SqliteFourByFourCalculus, facts: DatabaseSync, path: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), '4x4-sqlite-'));
  const path = join(root, 'overcenter.sqlite');
  const facts = durable(path);
  const calculus = new SqliteFourByFourCalculus(path);
  try {
    run(calculus, facts, path);
  } finally {
    calculus.close();
    facts.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('SQLite executes permits and unresolved effect-attempt queries from the relations', () => {
  withCalculus((calculus) => {
    const value = projection();
    calculus.replaceProjection('h1', value);
    assert.deepEqual(calculus.permittedEvents().value, ['e-old', 'e-open', 'e-released']);
    assert.deepEqual(calculus.permittedEvents('c-open').value, ['e-open']);
    assert.deepEqual(calculus.unresolvedEvents().value, ['e-old', 'e-open']);
    assert.deepEqual(calculus.unresolvedEvents('c-open').value, ['e-open']);
  });
});

test('recursive requirements terminate on cycles and coordinate-mismatched support stays unsupported', () => {
  withCalculus((calculus) => {
    const value = projection();
    calculus.replaceProjection('h1', value);
    assert.deepEqual(calculus.transitiveRequirements('p-goal').value, ['p-a', 'p-b', 'p-c']);
    assert.deepEqual(calculus.unsupportedRequirements('p-goal').value, ['p-b', 'p-c']);
    assert.deepEqual(
      calculus.staleSupports('c-requirements').value,
      referenceStaleSupports(value, 'c-requirements'),
    );
  });
});

test('stale permission is relative to the current event coordinate, not the authority coordinate', () => {
  withCalculus((calculus) => {
    const value = projection();
    calculus.replaceProjection('h1', value);
    assert.deepEqual(
      calculus.stalePermissions('c-open').value,
      referenceStalePermissions(value, 'c-open'),
    );
    assert.ok(!calculus.stalePermissions('c-open').value.some((edge) => edge.event === 'e-open'));
  });
});

test('projection is reconstructible and never mutates durable fact history', () => {
  withCalculus((calculus, facts) => {
    const expected = projection();
    calculus.replaceProjection('h1', expected);
    assert.deepEqual(calculus.projection(), { head: 'h1', value: expected });
    const history = facts
      .prepare('SELECT sequence, commit_id FROM fact_commits ORDER BY sequence')
      .all() as Array<{ sequence: number; commit_id: string }>;
    assert.deepEqual(
      history.map((row) => ({ sequence: row.sequence, commit_id: row.commit_id })),
      [{ sequence: 1, commit_id: 'h1' }],
    );
  });
});

test('queries fail closed when durable authority advances beyond the materialized projection', () => {
  withCalculus((calculus, facts) => {
    calculus.replaceProjection('h1', projection());
    facts.prepare('UPDATE authority SET head = ?, sequence = 2 WHERE singleton = 1').run('h2');
    assert.throws(() => calculus.permittedEvents(), /FOUR_BY_FOUR_PROJECTION_STALE/);
    assert.throws(
      () => calculus.replaceProjection('h1', projection()),
      /FOUR_BY_FOUR_DURABLE_HEAD_MOVED/,
    );
  });
});

test('invalid typed edges roll back without damaging the previous projection', () => {
  withCalculus((calculus) => {
    const expected = projection();
    calculus.replaceProjection('h1', expected);
    const invalid: FourByFourProjection = {
      ...expected,
      permits: [{ id: 'bad', object: 'missing-object', event: 'e-open', sources }],
    };
    assert.throws(() => calculus.replaceProjection('h1', invalid), /FOREIGN KEY constraint failed/);
    assert.deepEqual(calculus.projection(), { head: 'h1', value: expected });
  });
});

test('hot-path tables remain typed and indexed instead of collapsing into a triple store', () => {
  withCalculus((calculus, _facts, path) => {
    calculus.replaceProjection('h1', projection());
    const db = new DatabaseSync(path);
    try {
      const tables = db
        .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'four_by_four_%'
        ORDER BY name
      `)
        .all() as Array<{ name: string }>;
      assert.deepEqual(
        tables.map((row) => row.name),
        [
          'four_by_four_asserts',
          'four_by_four_coordinate',
          'four_by_four_event',
          'four_by_four_object',
          'four_by_four_permits',
          'four_by_four_projection',
          'four_by_four_proposition',
          'four_by_four_requires',
          'four_by_four_supports',
        ],
      );
      const indexes = db
        .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name LIKE 'four_by_four_%'
        ORDER BY name
      `)
        .all() as Array<{ name: string }>;
      for (const required of [
        'four_by_four_event_role_coordinate',
        'four_by_four_permits_event',
        'four_by_four_supports_proposition',
        'four_by_four_requires_proposition',
      ])
        assert.ok(
          indexes.some((row) => row.name === required),
          `missing ${required}`,
        );
    } finally {
      db.close();
    }
  });
});

test('SQL calculus agrees with TypeScript reference semantics over the hostile projection', () => {
  withCalculus((calculus) => {
    const value = projection();
    calculus.replaceProjection('h1', value);
    assert.deepEqual(calculus.permittedEvents().value, referencePermitted(value));
    assert.deepEqual(calculus.permittedEvents('c-open').value, referencePermitted(value, 'c-open'));
    assert.deepEqual(
      calculus.transitiveRequirements('p-goal').value,
      referenceRequirements(value, 'p-goal'),
    );
    assert.deepEqual(
      calculus.unsupportedRequirements('p-goal').value,
      referenceUnsupported(value, 'p-goal'),
    );
    assert.deepEqual(
      calculus.staleSupports('c-requirements').value,
      referenceStaleSupports(value, 'c-requirements'),
    );
    assert.deepEqual(
      calculus.stalePermissions('c-open').value,
      referenceStalePermissions(value, 'c-open'),
    );
    assert.deepEqual(calculus.unresolvedEvents().value, referenceUnresolved(value));
  });
});

test('coordinate and requirement hot paths are explicitly index-backed', () => {
  withCalculus((calculus, _facts, path) => {
    calculus.replaceProjection('h1', projection());
    const db = new DatabaseSync(path);
    try {
      const permitPlan = db
        .prepare(`
        EXPLAIN QUERY PLAN
        SELECT DISTINCT event.id
        FROM four_by_four_event AS event INDEXED BY four_by_four_event_coordinate
        JOIN four_by_four_permits AS permits INDEXED BY four_by_four_permits_event
          ON permits.event_id = event.id
        WHERE event.coordinate_id = ?
        ORDER BY event.id
      `)
        .all('c-open') as Array<{ detail: string }>;
      const permitDetail = permitPlan.map((row) => row.detail).join('\n');
      assert.match(permitDetail, /four_by_four_event_coordinate/);
      assert.match(permitDetail, /four_by_four_permits_event/);

      const requirementPlan = db
        .prepare(`
        EXPLAIN QUERY PLAN
        WITH RECURSIVE requirement(id) AS (
          SELECT required_proposition_id
          FROM four_by_four_requires INDEXED BY four_by_four_requires_proposition
          WHERE proposition_id = ?
          UNION
          SELECT edge.required_proposition_id
          FROM four_by_four_requires AS edge INDEXED BY four_by_four_requires_proposition
          JOIN requirement AS current ON edge.proposition_id = current.id
        )
        SELECT id FROM requirement WHERE id <> ? ORDER BY id
      `)
        .all('p-goal', 'p-goal') as Array<{ detail: string }>;
      assert.match(
        requirementPlan.map((row) => row.detail).join('\n'),
        /four_by_four_requires_proposition/,
      );
    } finally {
      db.close();
    }
  });
});
