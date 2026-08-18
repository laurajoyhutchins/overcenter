import { normalizeGithubStackRequest } from 'lib/github-stack.js';

function assert(condition, message) { if (!condition) throw new Error(message); }

export async function runGithubStackTests() {
  const results = [];
  async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); }
  }

  await test('normalizes an exact ordered stack', async () => {
    const request = normalizeGithubStackRequest({
      repo: 'laurajoyhutchins/example',
      pull_requests: [
        { number: 10, expected_head: 'a'.repeat(40) },
        { number: 11, expected_head: 'B'.repeat(40) },
      ],
    });
    assert(request.pull_requests[0].number === 10 && request.pull_requests[1].number === 11, 'order changed');
    assert(request.pull_requests[1].expected_head === 'b'.repeat(40), 'SHA not normalized');
  });

  await test('rejects duplicate PR layers', async () => {
    let failed = false;
    try {
      normalizeGithubStackRequest({
        repo: 'laurajoyhutchins/example',
        pull_requests: [
          { number: 10, expected_head: 'a'.repeat(40) },
          { number: 10, expected_head: 'b'.repeat(40) },
        ],
      });
    } catch (error) { failed = error.code === 'INVALID_REQUEST'; }
    assert(failed, 'duplicate PR was accepted');
  });

  await test('requires at least two layers', async () => {
    let failed = false;
    try { normalizeGithubStackRequest({ repo: 'laurajoyhutchins/example', pull_requests: [{ number: 10, expected_head: 'a'.repeat(40) }] }); }
    catch (error) { failed = error.code === 'INVALID_REQUEST'; }
    assert(failed, 'single PR was accepted as a stack');
  });

  return { ok: results.every((result) => result.ok), passed: results.filter((result) => result.ok).length, total: results.length, results };
}