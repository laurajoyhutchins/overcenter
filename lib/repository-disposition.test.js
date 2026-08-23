import { createRepositoryLifecycleService, repositoryHealthProjection } from './repository-disposition.js';

function assert(value, message) { if (!value) throw new Error(message); }

class MemoryStore {
  constructor() { this.rows = new Map(); }
  async get(repository) { return this.rows.get(repository.toLowerCase()) || null; }
  async put(row) { this.rows.set(row.repository.toLowerCase(), JSON.parse(JSON.stringify(row))); return this.get(row.repository); }
}

class FakeGithub {
  constructor(archived = false) { this.archived = archived; this.calls = 0; }
  async getRepository(repository) { this.calls += 1; return { full_name: repository, archived: this.archived }; }
}

export async function runRepositoryDispositionTests() {
  const tests = [];
  async function test(name, fn) { try { await fn(); tests.push({ name, ok: true }); } catch (error) { tests.push({ name, ok: false, error: String(error?.message || error) }); } }
  // Production lifecycle behavior is exercised through the static imports above.

  await test('GitHub archived evidence deterministically yields ARCHIVED', async () => {
    const service = createRepositoryLifecycleService({ store: new MemoryStore(), github: new FakeGithub(true), now: () => '2026-08-22T16:00:00.000Z' });
    const row = await service.observe('Owner/Repo');
    assert(row.disposition === 'ARCHIVED' && row.ordinary_work_enabled === false && row.github_archived === true, 'GitHub archive did not dispose repository');
  });

  await test('GitHub archive overrides a stale ACTIVE record', async () => {
    const store = new MemoryStore();
    await store.put({ repository:'owner/repo', disposition:'ACTIVE', compatibility_bound:false, successor_repository:null, github_archived:false });
    const service = createRepositoryLifecycleService({ store, github: new FakeGithub(true), now: () => '2026-08-22T16:00:00.000Z' });
    const row = await service.observe('owner/repo');
    assert(row.disposition === 'ARCHIVED' && row.ordinary_work_enabled === false, 'archived GitHub repository remained ACTIVE');
  });

  await test('external unarchive cannot reactivate disposed repository', async () => {
    const store = new MemoryStore();
    await store.put({ repository:'owner/repo', disposition:'ARCHIVED', compatibility_bound:false, successor_repository:null, github_archived:true });
    const service = createRepositoryLifecycleService({ store, github: new FakeGithub(false), now: () => '2026-08-22T16:00:00.000Z' });
    const row = await service.observe('owner/repo');
    assert(row.disposition === 'ARCHIVED' && row.ordinary_work_enabled === false && row.github_archived === false, 'external unarchive silently reactivated repository');
  });

  await test('explicit lifecycle transition can restore an unarchived repository', async () => {
    const store = new MemoryStore();
    await store.put({ repository:'owner/repo', disposition:'ARCHIVED', compatibility_bound:false, successor_repository:null, github_archived:true });
    const service = createRepositoryLifecycleService({ store, github: new FakeGithub(false), now: () => '2026-08-22T16:00:00.000Z' });
    const row = await service.transition({ repository:'owner/repo', disposition:'ACTIVE', expected_disposition:'ARCHIVED', reason:'owner-approved reactivation' });
    assert(row.disposition === 'ACTIVE' && row.ordinary_work_enabled === true, 'explicit transition did not restore ACTIVE');
  });

  await test('SUPERSEDED is terminal for ordinary work and routes to successor', async () => {
    const store = new MemoryStore();
    const service = createRepositoryLifecycleService({ store, github: new FakeGithub(true), now: () => '2026-08-22T16:00:00.000Z' });
    const row = await service.dispose({ repository:'owner/old', disposition:'SUPERSEDED', successor_repository:'owner/new', reason:'responsibility moved' });
    assert(row.disposition === 'SUPERSEDED' && row.successor_repository === 'owner/new' && row.ordinary_work_enabled === false, 'superseded routing semantics incorrect');
  });

  await test('retired compatibility execution exceptions are rejected', async () => {
    const store = new MemoryStore();
    const service = createRepositoryLifecycleService({ store, github: new FakeGithub(true), now: () => '2026-08-22T16:00:00.000Z' });
    let failure = null;
    try { await service.dispose({ repository:'owner/bridge', disposition:'ARCHIVED', compatibility_bound:true, compatibility_reference:'legacy runtime', reason:'historical compatibility' }); }
    catch (error) { failure = error; }
    assert(failure?.code === 'LEGACY_CONTROL_PLANE_RETIRED', `legacy compatibility bound was not rejected: ${failure?.code}`);
  });

  // Repository-specific retirement history is not part of the current lifecycle contract.

  await test('disposal is idempotent for identical semantics', async () => {
    const store = new MemoryStore();
    const service = createRepositoryLifecycleService({ store, github: new FakeGithub(true), now: () => '2026-08-22T16:00:00.000Z' });
    const a = await service.dispose({ repository:'owner/repo', disposition:'ARCHIVED', reason:'retired' });
    const b = await service.dispose({ repository:'owner/repo', disposition:'ARCHIVED', reason:'retired' });
    assert(a.disposition === b.disposition && b.changed === false, 'repeated disposal was not idempotent');
  });

  await test('DORMANT is intentionally non-executable without becoming historical disposal', async () => {
    const store = new MemoryStore();
    await store.put({ repository:'owner/repo', disposition:'ACTIVE', compatibility_bound:false, successor_repository:null, github_archived:false });
    const service = createRepositoryLifecycleService({ store, github: new FakeGithub(false), now: () => '2026-08-22T16:00:00.000Z' });
    const row = await service.transition({ repository:'owner/repo', disposition:'DORMANT', expected_disposition:'ACTIVE', reason:'intentionally parked' });
    assert(row.ordinary_work_enabled === false && row.fast_forward_eligible === false && row.scheduled_worker_target === false, 'DORMANT remained executable');
    assert(row.health.classification === 'dormant_as_intended' && row.health.include_in_active_health === false, 'DORMANT leaked into active health or was classified as disposal');
  });

  await test('disposed repository health is intentional preservation state', async () => {
    const health = repositoryHealthProjection({ disposition:'ARCHIVED', ordinary_work_enabled:false, compatibility_bound:false });
    assert(health.classification === 'disposed_as_intended' && health.include_in_active_health === false, 'disposed repository leaked into active health');
  });

  return { ok: tests.every(test => test.ok), passed: tests.filter(test => test.ok).length, failed: tests.filter(test => !test.ok).length, tests };
}