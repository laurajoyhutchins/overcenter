import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ARCHITECTURE_SQL_PATHS = [
  'architecture/concepts.sql',
  'architecture/logic.sql',
  'architecture/physics.sql',
] as const;

export type ArchitectureSqlReader = (path: string) => string;

export function loadArchitectureDatabase(
  root = process.cwd(),
  readSql: ArchitectureSqlReader = (path) => readFileSync(resolve(root, path), 'utf8'),
): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const path of ARCHITECTURE_SQL_PATHS) {
      db.exec(readSql(path));
    }
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) throw new Error('ARCHITECTURE_FOREIGN_KEY_VIOLATION');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
