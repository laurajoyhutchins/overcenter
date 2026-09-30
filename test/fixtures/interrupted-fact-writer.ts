import { DatabaseSync } from 'node:sqlite';
import { GitFactStore } from '../../src/storage/git-store.ts';
import { SqliteFactStore } from './sqlite-store.ts';
const [backend, path, expected, phase] = process.argv.slice(2);
if (!path || !expected) throw new Error('WRITER_ARGUMENTS');
if (backend === 'git') {
  const store = new GitFactStore(path, { ref: 'refs/overcenter/state' });
  if (phase === 'after') store.append(expected, 'winner');
  else store.createCommit(expected, 'unpublished', { 'claim.json': { orphan: true } });
} else if (phase === 'after') {
  const store = new SqliteFactStore(path);
  store.append(expected, 'winner');
} else {
  const db = new DatabaseSync(path);
  db.exec('BEGIN IMMEDIATE');
  db.prepare(
    'INSERT INTO fact_commits(sequence,commit_id,parent_id,message,files_json) VALUES(2,?,?,?,?)',
  ).run('unpublished', expected, 'unpublished', '{}');
}
process.stdout.write('ready\n');
setInterval(() => {}, 1000);
