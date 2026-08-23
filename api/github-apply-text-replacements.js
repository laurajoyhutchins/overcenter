import { db } from 'hatchable';
import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { applyGithubChangeset } from 'lib/github-apply-changeset.js';

export const access = 'admin';
export const methods = ['POST'];

function decodeBase64Utf8(value) {
  const binary = atob(String(value || '').replace(/\s+/g, ''));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function occurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + needle.length;
  }
}

function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

export default async function (req, res) {
  const body = req.body || {};
  const replacements = Array.isArray(body.replacements) ? body.replacements : [];
  if (!body.repo || !body.branch || !body.expected_head || !body.commit_message || replacements.length < 1 || replacements.length > 32) {
    return res.status(422).json({ ok: false, error: 'INVALID_REQUEST', message: 'repo, branch, expected_head, commit_message, and 1..32 replacements are required' });
  }

  try {
    const result = await withGitHubAppApiClient(body.repo, async (apiClient) => {
      const byPath = new Map();
      for (let index = 0; index < replacements.length; index += 1) {
        const replacement = replacements[index];
        const path = String(replacement?.path || '');
        const oldText = replacement?.old;
        const newText = replacement?.new_text;
        const expectedCount = replacement?.expected_count === undefined ? 1 : Number(replacement.expected_count);
        if (!path || typeof oldText !== 'string' || oldText.length === 0 || typeof newText !== 'string' || !Number.isInteger(expectedCount) || expectedCount < 1) {
          throw Object.assign(new Error(`invalid replacement at index ${index}`), { code: 'INVALID_REPLACEMENT', index });
        }
        if (!byPath.has(path)) byPath.set(path, []);
        byPath.get(path).push({ oldText, newText, expectedCount, index });
      }

      const changes = [];
      for (const [path, specs] of byPath.entries()) {
        const response = await apiClient.call('github', {
          method: 'GET',
          path: `/repos/${body.repo.split('/').map(encodeURIComponent).join('/')}/contents/${encodePath(path)}`,
          query: { ref: body.branch },
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Busbar/1.0' },
        });
        if (Number(response?.status || 0) !== 200 || response?.body?.encoding !== 'base64') {
          throw Object.assign(new Error(`unable to read ${path} at expected_head`), { code: 'SOURCE_READ_FAILED', path, status: response?.status || null });
        }
        let content = decodeBase64Utf8(response.body.content);
        for (const spec of specs) {
          const actualCount = occurrences(content, spec.oldText);
          if (actualCount !== spec.expectedCount) {
            throw Object.assign(new Error(`replacement precondition failed for ${path}`), {
              code: 'TEXT_PRECONDITION_FAILED',
              path,
              replacement_index: spec.index,
              expected_count: spec.expectedCount,
              actual_count: actualCount,
            });
          }
          content = content.split(spec.oldText).join(spec.newText);
        }
        changes.push({ path, operation: 'update', content, ensure_final_newline: content.endsWith('\n') });
      }

      return applyGithubChangeset({
        repo: body.repo,
        base_ref: body.branch,
        branch: body.branch,
        expected_head: body.expected_head,
        changes,
        commit_message: body.commit_message,
        ...(body.idempotency_key ? { idempotency_key: body.idempotency_key } : {}),
      }, { apiClient, db });
    }, { permissionProfile: 'changeset' });

    return res.status(result?.ok ? 200 : 409).json(result);
  } catch (error) {
    return res.status(422).json({
      ok: false,
      error: error?.code || 'TEXT_REPLACEMENT_FAILED',
      message: String(error?.message || error),
      ...(error?.path ? { path: error.path } : {}),
      ...(error?.replacement_index !== undefined ? { replacement_index: error.replacement_index } : {}),
      ...(error?.expected_count !== undefined ? { expected_count: error.expected_count } : {}),
      ...(error?.actual_count !== undefined ? { actual_count: error.actual_count } : {}),
    });
  }
}