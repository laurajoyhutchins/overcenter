import { DatabaseSync } from 'node:sqlite';

import type { Data } from '../model.ts';
import type {
  FourByFourProjection,
  FourByFourSource,
} from './effect-history-projection.ts';

export interface StaleSupport {
  id: string;
  object: string;
  proposition: string;
  object_coordinate: string;
  proposition_coordinate: string;
}

export interface StalePermission {
  id: string;
  object: string;
  event: string;
  event_coordinate: string;
}

export interface CalculusResult<T> {
  head: string;
  value: T;
}

interface HeadRow { head: string | null }
interface IdRow { id: string }
interface StoredCoordinateRow { id: string; value_json: string; sources_json: string }
interface StoredNounRow extends StoredCoordinateRow { coordinate_id: string; role: string }
interface StoredPermitsRow { id: string; object_id: string; event_id: string; sources_json: string }
interface StoredAssertsRow { id: string; event_id: string; proposition_id: string; sources_json: string }
interface StoredSupportsRow { id: string; object_id: string; proposition_id: string; sources_json: string }
interface StoredRequiresRow { id: string; proposition_id: string; required_proposition_id: string; sources_json: string }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS four_by_four_projection (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  head TEXT NOT NULL CHECK(length(trim(head)) > 0)
) STRICT;
CREATE TABLE IF NOT EXISTS four_by_four_coordinate (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
  value_json TEXT NOT NULL,
  sources_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS four_by_four_object (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
  coordinate_id TEXT NOT NULL REFERENCES four_by_four_coordinate(id),
  role TEXT NOT NULL CHECK(length(trim(role)) > 0),
  value_json TEXT NOT NULL,
  sources_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS four_by_four_event (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
  coordinate_id TEXT NOT NULL REFERENCES four_by_four_coordinate(id),
  role TEXT NOT NULL CHECK(length(trim(role)) > 0),
  value_json TEXT NOT NULL,
  sources_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS four_by_four_proposition (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
  coordinate_id TEXT NOT NULL REFERENCES four_by_four_coordinate(id),
  role TEXT NOT NULL CHECK(length(trim(role)) > 0),
  value_json TEXT NOT NULL,
  sources_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS four_by_four_permits (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
  object_id TEXT NOT NULL REFERENCES four_by_four_object(id),
  event_id TEXT NOT NULL REFERENCES four_by_four_event(id),
  sources_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS four_by_four_asserts (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
  event_id TEXT NOT NULL REFERENCES four_by_four_event(id),
  proposition_id TEXT NOT NULL REFERENCES four_by_four_proposition(id),
  sources_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS four_by_four_supports (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
  object_id TEXT NOT NULL REFERENCES four_by_four_object(id),
  proposition_id TEXT NOT NULL REFERENCES four_by_four_proposition(id),
  sources_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS four_by_four_requires (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
  proposition_id TEXT NOT NULL REFERENCES four_by_four_proposition(id),
  required_proposition_id TEXT NOT NULL REFERENCES four_by_four_proposition(id),
  sources_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS four_by_four_object_coordinate ON four_by_four_object(coordinate_id);
CREATE INDEX IF NOT EXISTS four_by_four_event_coordinate ON four_by_four_event(coordinate_id);
CREATE INDEX IF NOT EXISTS four_by_four_proposition_coordinate ON four_by_four_proposition(coordinate_id);
CREATE INDEX IF NOT EXISTS four_by_four_event_role_coordinate ON four_by_four_event(role, coordinate_id);
CREATE INDEX IF NOT EXISTS four_by_four_proposition_role_coordinate ON four_by_four_proposition(role, coordinate_id);
CREATE INDEX IF NOT EXISTS four_by_four_permits_event ON four_by_four_permits(event_id, object_id);
CREATE INDEX IF NOT EXISTS four_by_four_permits_object ON four_by_four_permits(object_id, event_id);
CREATE INDEX IF NOT EXISTS four_by_four_asserts_event ON four_by_four_asserts(event_id, proposition_id);
CREATE INDEX IF NOT EXISTS four_by_four_asserts_proposition ON four_by_four_asserts(proposition_id, event_id);
CREATE INDEX IF NOT EXISTS four_by_four_supports_proposition ON four_by_four_supports(proposition_id, object_id);
CREATE INDEX IF NOT EXISTS four_by_four_supports_object ON four_by_four_supports(object_id, proposition_id);
CREATE INDEX IF NOT EXISTS four_by_four_requires_proposition ON four_by_four_requires(proposition_id, required_proposition_id);
CREATE INDEX IF NOT EXISTS four_by_four_requires_required ON four_by_four_requires(required_proposition_id, proposition_id);
`;

function encoded(value: unknown): string { return JSON.stringify(value); }
function decoded<T>(value: string): T { return JSON.parse(value) as T; }

export class SqliteFourByFourCalculus {
  readonly path: string;
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#requireDurableAuthority();
    this.#db.exec(SCHEMA);
  }

  close(): void { this.#db.close(); }

  replaceProjection(head: string, projection: FourByFourProjection): void {
    if (head.trim().length === 0) throw new Error('FOUR_BY_FOUR_HEAD_INVALID');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#assertDurableHead(head);
      this.#clearProjection();
      this.#insertProjection(projection);
      this.#db.prepare(`
        INSERT INTO four_by_four_projection(singleton, head)
        VALUES(1, ?)
        ON CONFLICT(singleton) DO UPDATE SET head = excluded.head
      `).run(head);
      this.#assertDurableHead(head);
      this.#db.exec('COMMIT');
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  projection(): CalculusResult<FourByFourProjection> {
    return this.#read((head) => ({
      head,
      value: {
        coordinates: (this.#db.prepare(`
          SELECT id, value_json, sources_json FROM four_by_four_coordinate ORDER BY id
        `).all() as unknown as StoredCoordinateRow[]).map((row) => ({
          id: row.id,
          value: decoded<Data>(row.value_json),
          sources: decoded<FourByFourSource[]>(row.sources_json),
        })),
        objects: this.#nouns('object'),
        events: this.#nouns('event'),
        propositions: this.#nouns('proposition'),
        permits: (this.#db.prepare(`
          SELECT id, object_id, event_id, sources_json FROM four_by_four_permits ORDER BY id
        `).all() as unknown as StoredPermitsRow[]).map((row) => ({
          id: row.id,
          object: row.object_id,
          event: row.event_id,
          sources: decoded<FourByFourSource[]>(row.sources_json),
        })),
        asserts: (this.#db.prepare(`
          SELECT id, event_id, proposition_id, sources_json FROM four_by_four_asserts ORDER BY id
        `).all() as unknown as StoredAssertsRow[]).map((row) => ({
          id: row.id,
          event: row.event_id,
          proposition: row.proposition_id,
          sources: decoded<FourByFourSource[]>(row.sources_json),
        })),
        supports: (this.#db.prepare(`
          SELECT id, object_id, proposition_id, sources_json FROM four_by_four_supports ORDER BY id
        `).all() as unknown as StoredSupportsRow[]).map((row) => ({
          id: row.id,
          object: row.object_id,
          proposition: row.proposition_id,
          sources: decoded<FourByFourSource[]>(row.sources_json),
        })),
        requires: (this.#db.prepare(`
          SELECT id, proposition_id, required_proposition_id, sources_json
          FROM four_by_four_requires ORDER BY id
        `).all() as unknown as StoredRequiresRow[]).map((row) => ({
          id: row.id,
          proposition: row.proposition_id,
          required: row.required_proposition_id,
          sources: decoded<FourByFourSource[]>(row.sources_json),
        })),
      },
    }));
  }

  permittedEvents(coordinate?: string): CalculusResult<string[]> {
    return this.#read((head) => {
      const rows = (coordinate === undefined
        ? this.#db.prepare(`
            SELECT DISTINCT event.id
            FROM four_by_four_event AS event
            JOIN four_by_four_permits AS permits INDEXED BY four_by_four_permits_event
              ON permits.event_id = event.id
            ORDER BY event.id
          `).all()
        : this.#db.prepare(`
            SELECT DISTINCT event.id
            FROM four_by_four_event AS event INDEXED BY four_by_four_event_coordinate
            JOIN four_by_four_permits AS permits INDEXED BY four_by_four_permits_event
              ON permits.event_id = event.id
            WHERE event.coordinate_id = ?
            ORDER BY event.id
          `).all(coordinate)) as unknown as IdRow[];
      return { head, value: rows.map((row) => row.id) };
    });
  }

  transitiveRequirements(proposition: string): CalculusResult<string[]> {
    return this.#read((head) => {
      this.#assertProposition(proposition);
      const rows = this.#db.prepare(`
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
      `).all(proposition, proposition) as unknown as IdRow[];
      return { head, value: rows.map((row) => row.id) };
    });
  }

  unsupportedRequirements(proposition: string): CalculusResult<string[]> {
    return this.#read((head) => {
      this.#assertProposition(proposition);
      const rows = this.#db.prepare(`
        WITH RECURSIVE requirement(id) AS (
          SELECT required_proposition_id
          FROM four_by_four_requires INDEXED BY four_by_four_requires_proposition
          WHERE proposition_id = ?
          UNION
          SELECT edge.required_proposition_id
          FROM four_by_four_requires AS edge INDEXED BY four_by_four_requires_proposition
          JOIN requirement AS current ON edge.proposition_id = current.id
        ), exact_support(id) AS (
          SELECT DISTINCT supports.proposition_id
          FROM four_by_four_supports AS supports INDEXED BY four_by_four_supports_proposition
          JOIN four_by_four_object AS object ON object.id = supports.object_id
          JOIN four_by_four_proposition AS proposition ON proposition.id = supports.proposition_id
          WHERE object.coordinate_id = proposition.coordinate_id
        )
        SELECT requirement.id
        FROM requirement
        LEFT JOIN exact_support ON exact_support.id = requirement.id
        WHERE exact_support.id IS NULL AND requirement.id <> ?
        ORDER BY requirement.id
      `).all(proposition, proposition) as unknown as IdRow[];
      return { head, value: rows.map((row) => row.id) };
    });
  }

  staleSupports(currentCoordinate: string): CalculusResult<StaleSupport[]> {
    return this.#read((head) => {
      const rows = this.#db.prepare(`
        SELECT supports.id, supports.object_id AS object,
          supports.proposition_id AS proposition,
          object.coordinate_id AS object_coordinate,
          proposition.coordinate_id AS proposition_coordinate
        FROM four_by_four_supports AS supports
        JOIN four_by_four_object AS object ON object.id = supports.object_id
        JOIN four_by_four_proposition AS proposition ON proposition.id = supports.proposition_id
        WHERE proposition.coordinate_id <> ?
           OR object.coordinate_id <> proposition.coordinate_id
        ORDER BY supports.id
      `).all(currentCoordinate) as unknown as StaleSupport[];
      return { head, value: rows.map((row) => ({ ...row })) };
    });
  }

  stalePermissions(currentCoordinate: string): CalculusResult<StalePermission[]> {
    return this.#read((head) => {
      const rows = this.#db.prepare(`
        SELECT permits.id, permits.object_id AS object, permits.event_id AS event,
          event.coordinate_id AS event_coordinate
        FROM four_by_four_permits AS permits
        JOIN four_by_four_event AS event ON event.id = permits.event_id
        WHERE event.coordinate_id <> ?
        ORDER BY permits.id
      `).all(currentCoordinate) as unknown as StalePermission[];
      return { head, value: rows.map((row) => ({ ...row })) };
    });
  }

  unresolvedEvents(coordinate?: string): CalculusResult<string[]> {
    return this.#read((head) => {
      const coordinateClause = coordinate === undefined ? '' : 'AND event.coordinate_id = ?';
      const statement = this.#db.prepare(`
        SELECT DISTINCT event.id
        FROM four_by_four_event AS event INDEXED BY four_by_four_event_role_coordinate
        JOIN four_by_four_permits AS permits INDEXED BY four_by_four_permits_event
          ON permits.event_id = event.id
        WHERE event.role = 'effect-attempt'
          ${coordinateClause}
          AND json_type(event.value_json, '$.reservation_commit') = 'text'
          AND NOT EXISTS (
            SELECT 1
            FROM four_by_four_proposition AS proposition INDEXED BY four_by_four_proposition_role_coordinate
            JOIN four_by_four_asserts AS asserts INDEXED BY four_by_four_asserts_proposition
              ON asserts.proposition_id = proposition.id
            JOIN four_by_four_coordinate AS proposition_coordinate
              ON proposition_coordinate.id = proposition.coordinate_id
            WHERE proposition.role = 'not-dispatched'
              AND json_extract(proposition_coordinate.value_json, '$.reservation_commit') =
                  json_extract(event.value_json, '$.reservation_commit')
          )
        ORDER BY event.id
      `);
      const rows = (coordinate === undefined ? statement.all() : statement.all(coordinate)) as unknown as IdRow[];
      return { head, value: rows.map((row) => row.id) };
    });
  }

  #read<T>(read: (head: string) => CalculusResult<T>): CalculusResult<T> {
    this.#db.exec('BEGIN');
    try {
      const head = this.#boundHead();
      const result = read(head);
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  #boundHead(): string {
    const durable = this.#durableHead();
    const projection = this.#db.prepare(
      'SELECT head FROM four_by_four_projection WHERE singleton = 1',
    ).get() as HeadRow | undefined;
    if (!projection) throw new Error('FOUR_BY_FOUR_PROJECTION_MISSING');
    if (durable === null || projection.head !== durable) throw new Error('FOUR_BY_FOUR_PROJECTION_STALE');
    return durable;
  }

  #assertDurableHead(head: string): void {
    if (this.#durableHead() !== head) throw new Error('FOUR_BY_FOUR_DURABLE_HEAD_MOVED');
  }

  #durableHead(): string | null {
    const row = this.#db.prepare('SELECT head FROM authority WHERE singleton = 1').get() as HeadRow | undefined;
    if (!row) throw new Error('FOUR_BY_FOUR_DURABLE_AUTHORITY_MISSING');
    return row.head;
  }

  #requireDurableAuthority(): void {
    const authority = this.#db.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'authority'
    `).get() as { present: number } | undefined;
    if (!authority) throw new Error('FOUR_BY_FOUR_DURABLE_AUTHORITY_MISSING');
    this.#durableHead();
  }

  #assertProposition(id: string): void {
    const row = this.#db.prepare('SELECT id FROM four_by_four_proposition WHERE id = ?').get(id) as IdRow | undefined;
    if (!row) throw new Error(`FOUR_BY_FOUR_PROPOSITION_UNKNOWN:${id}`);
  }

  #clearProjection(): void {
    this.#db.exec(`
      DELETE FROM four_by_four_asserts;
      DELETE FROM four_by_four_supports;
      DELETE FROM four_by_four_requires;
      DELETE FROM four_by_four_permits;
      DELETE FROM four_by_four_object;
      DELETE FROM four_by_four_event;
      DELETE FROM four_by_four_proposition;
      DELETE FROM four_by_four_coordinate;
    `);
  }

  #insertProjection(projection: FourByFourProjection): void {
    const coordinate = this.#db.prepare(`
      INSERT INTO four_by_four_coordinate(id, value_json, sources_json) VALUES(?, ?, ?)
    `);
    for (const row of projection.coordinates) coordinate.run(row.id, encoded(row.value), encoded(row.sources));

    for (const [kind, rows] of [
      ['object', projection.objects], ['event', projection.events], ['proposition', projection.propositions],
    ] as const) {
      const insert = this.#db.prepare(`
        INSERT INTO four_by_four_${kind}(id, coordinate_id, role, value_json, sources_json)
        VALUES(?, ?, ?, ?, ?)
      `);
      for (const row of rows) insert.run(row.id, row.coordinate, row.role, encoded(row.value), encoded(row.sources));
    }

    const permits = this.#db.prepare(`
      INSERT INTO four_by_four_permits(id, object_id, event_id, sources_json) VALUES(?, ?, ?, ?)
    `);
    for (const row of projection.permits) permits.run(row.id, row.object, row.event, encoded(row.sources));

    const asserts = this.#db.prepare(`
      INSERT INTO four_by_four_asserts(id, event_id, proposition_id, sources_json) VALUES(?, ?, ?, ?)
    `);
    for (const row of projection.asserts) asserts.run(row.id, row.event, row.proposition, encoded(row.sources));

    const supports = this.#db.prepare(`
      INSERT INTO four_by_four_supports(id, object_id, proposition_id, sources_json) VALUES(?, ?, ?, ?)
    `);
    for (const row of projection.supports) supports.run(row.id, row.object, row.proposition, encoded(row.sources));

    const requires = this.#db.prepare(`
      INSERT INTO four_by_four_requires(id, proposition_id, required_proposition_id, sources_json)
      VALUES(?, ?, ?, ?)
    `);
    for (const row of projection.requires) requires.run(row.id, row.proposition, row.required, encoded(row.sources));
  }

  #nouns(kind: 'object' | 'event' | 'proposition') {
    const rows = this.#db.prepare(`
      SELECT id, coordinate_id, role, value_json, sources_json FROM four_by_four_${kind} ORDER BY id
    `).all() as unknown as StoredNounRow[];
    return rows.map((row) => ({
      id: row.id,
      coordinate: row.coordinate_id,
      role: row.role,
      value: decoded<Data>(row.value_json),
      sources: decoded<FourByFourSource[]>(row.sources_json),
    }));
  }
}