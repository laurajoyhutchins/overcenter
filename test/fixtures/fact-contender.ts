import { SqliteFactStore as ProductionStore } from '../../src/storage/sqlite.ts';
import { GitFactStore } from './git-fact-store.ts';
import { SqliteFactStore } from './sqlite-store.ts';
const [backend, path, expected, label, remote] = process.argv.slice(2);
if (!path || !label) throw new Error('CONTENDER_ARGUMENTS');
const store =
  backend === 'composed'
    ? new ProductionStore(path, { ref: 'refs/overcenter/state', remote: remote ?? null })
    : backend === 'git'
      ? new GitFactStore(path, { ref: 'refs/overcenter/state', remote: remote ?? null })
      : new SqliteFactStore(path);
store.head();
const commit = store.append(expected === '-' ? null : expected!, `writer ${label}`, {
  'claim.json': { label },
});
if (store instanceof SqliteFactStore || store instanceof ProductionStore) store.close();
process.stdout.write(JSON.stringify({ commit }));
