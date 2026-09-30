import { GitFactStore } from '../../src/storage/git-store.ts';
import { SqliteFactStore } from './sqlite-store.ts';
const [backend, path, expected, label, remote] = process.argv.slice(2);
if (!path || !label) throw new Error('CONTENDER_ARGUMENTS');
const store =
  backend === 'git'
    ? new GitFactStore(path, { ref: 'refs/overcenter/state', remote: remote ?? null })
    : new SqliteFactStore(path);
const commit = store.append(expected === '-' ? null : expected!, `writer ${label}`, {
  'claim.json': { label },
});
if (store instanceof SqliteFactStore) store.close();
process.stdout.write(JSON.stringify({ commit }));
