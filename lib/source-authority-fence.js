function failure(code, message, details = {}) {
  return Object.assign(new Error(message), {
    code,
    details:Object.freeze({ ...details, may_have_mutated:false }),
    may_have_mutated:false,
    mayHaveMutated:false,
  });
}

export async function assertSourceAuthorityWritable(db) {
  if (!db || typeof db.query !== 'function') {
    throw failure('SOURCE_AUTHORITY_STATE_UNAVAILABLE', 'source authority fence requires a database provider');
  }
  let row;
  try {
    const result = await db.query(
      `SELECT frozen, frozen_at, source_revision, freeze_manifest_sha256
         FROM overcenter_authority_freeze
        WHERE singleton=true
        LIMIT 1`,
    );
    row = result?.rows?.[0] || null;
  } catch (error) {
    throw failure('SOURCE_AUTHORITY_STATE_UNAVAILABLE', 'source authority fence could not read cutover state', {
      cause:String(error?.code || error?.message || error),
    });
  }
  if (!row) {
    throw failure('SOURCE_AUTHORITY_STATE_UNAVAILABLE', 'source authority fence row is missing');
  }
  if (row.frozen === true) {
    throw failure('SOURCE_AUTHORITY_FROZEN', 'Hatchable source authority is permanently frozen', {
      frozen_at:row.frozen_at || null,
      source_revision:row.source_revision || null,
      freeze_manifest_sha256:row.freeze_manifest_sha256 || null,
    });
  }
  return Object.freeze({
    frozen:false,
    source_revision:row.source_revision || null,
  });
}

export function fenceSourceGitHubAppAuth(githubAppAuth, db) {
  if (!githubAppAuth || typeof githubAppAuth.withApiClient !== 'function') {
    throw new TypeError('githubAppAuth.withApiClient is required');
  }
  return Object.freeze({
    ...githubAppAuth,
    async withApiClient(repository, callback, options) {
      await assertSourceAuthorityWritable(db);
      return githubAppAuth.withApiClient(repository, async (client) => {
        if (!client || typeof client.call !== 'function') {
          throw failure('SOURCE_AUTHORITY_PROVIDER_INVALID', 'GitHub API client is unavailable');
        }
        const fencedClient = new Proxy(client, {
          get(target, property, receiver) {
            if (property !== 'call') return Reflect.get(target, property, receiver);
            return async (...args) => {
              await assertSourceAuthorityWritable(db);
              return target.call(...args);
            };
          },
        });
        return callback(fencedClient);
      }, options);
    },
  });
}

export function fenceSourceApiProvider(api, db) {
  if (!api || typeof api.call !== 'function') return api;
  return Object.freeze({
    ...api,
    async call(...args) {
      await assertSourceAuthorityWritable(db);
      return api.call(...args);
    },
  });
}
