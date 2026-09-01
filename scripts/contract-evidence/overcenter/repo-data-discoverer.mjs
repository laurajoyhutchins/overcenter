import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fingerprintStructure, sourceIdentity } from '../canonical.mjs';

function repoPath(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join('/');
}

async function collect(path) {
  const stat = await lstat(path);
  if (stat.isFile()) return path.endsWith('.json') ? [path] : [];
  if (!stat.isDirectory()) return [];
  const files = [];
  const entries = await readdir(path, { withFileTypes:true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await collect(child));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(child);
  }
  return files;
}

export function createRepoDataDiscoverer(options = {}) {
  const roots = options.roots || ['.overcenter/project-definitions.json', '.overcenter/definitions'];
  return {
    name:'overcenter-repo-data',
    async discover({ repoRoot }) {
      const files = [];
      for (const root of roots) files.push(...await collect(join(repoRoot, root)));
      const unique = [...new Set(files)].sort();
      const candidates = [];
      for (const file of unique) {
        const path = repoPath(repoRoot, file);
        let structure;
        try {
          structure = JSON.parse(await readFile(file, 'utf8'));
        } catch (cause) {
          const error = new Error(`cannot parse repository-owned JSON ${path}`, { cause });
          Object.assign(error, { code:'CONTRACT_REPO_DATA_INVALID', path });
          throw error;
        }
        const anchor = typeof structure?.schema === 'string' && structure.schema ? structure.schema : 'document';
        candidates.push({
          source_identity:sourceIdentity('repo-data', path, anchor),
          source_kind:'repo-data',
          source_location:{ path, anchor },
          symbol_or_boundary:anchor,
          structural_fingerprint:fingerprintStructure(structure),
          structure,
          observed_relationships:[],
        });
      }
      candidates.sort((a, b) => a.source_identity.localeCompare(b.source_identity));
      return { complete:true, candidates, diagnostics:[{ code:'REPO_DATA_DISCOVERY_COMPLETE', count:candidates.length }] };
    },
  };
}
