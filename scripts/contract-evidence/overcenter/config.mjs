import { join } from 'node:path';
import { createPostgresDiscoverer } from './postgres-discoverer.mjs';
import { createRepoDataDiscoverer } from './repo-data-discoverer.mjs';
import { createSemanticDescriptorDiscoverer } from './semantic-descriptor-discoverer.mjs';
import { readOvercenterSemverKinds } from './semver-policy.mjs';
import { createSourceDiscoverer } from './source-discoverer.mjs';
import { createTransportDiscoverer } from './transport-discoverer.mjs';

export default Object.freeze({
  classificationPath:'.contract-evidence/classifications.json',
  discoverers:Object.freeze([
    createSourceDiscoverer({
      typescriptRoot:'src',
      javascriptRoot:'lib',
      runtimeTsconfig:'tsconfig.semantic.runtime.json',
    }),
    createSemanticDescriptorDiscoverer({
      source:'src/semantic/semantic-command-descriptors.ts',
    }),
    createTransportDiscoverer({
      mcpRoot:'mcp',
      apiRoot:'api',
    }),
    createRepoDataDiscoverer({
      roots:['.overcenter/project-definitions.json', '.overcenter/definitions'],
    }),
    createPostgresDiscoverer({
      migrationsRoot:'migrations',
    }),
  ]),
  async resolveAllowedSemverKinds({ repoRoot }) {
    return readOvercenterSemverKinds(join(repoRoot, 'src/semantic/semver-public-api.ts'));
  },
});
