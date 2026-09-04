import { githubChangesetSemanticRequestHash } from 'lib/github-apply-changeset.js';
import { expandGithubContentReferences, prepareGithubContentReference, resolveGithubContentReference } from 'lib/github-content-transport.js';
import { selectGithubTextTransport } from 'lib/github-text-transport.js';

function check(condition, message) { if (!condition) throw new Error(message); }
async function run(name, fn) { try { await fn(); return { name, ok:true }; } catch (error) { return { name, ok:false, error:String(error?.code ? `${error.code}: ${error.message}` : error?.message || error) }; } }
async function expectError(promise, code) { let observed = null; try { await promise; } catch (error) { observed = error; } check(observed?.code === code, `expected ${code}, observed ${observed?.code || 'success'}`); return observed; }

function deterministicNoise(length) {
  let state = 0x9e3779b9;
  let text = '';
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    text += String.fromCharCode(32 + ((state >>> 16) % 95));
  }
  return text;
}

function bytes(value) { return value instanceof Uint8Array ? value.slice() : new Uint8Array(value); }
class FakeStorage {
  constructor() { this.objects = new Map(); this.putCount = 0; this.failOnPut = null; }
  async put(key, buffer, contentType) {
    this.putCount += 1;
    if (this.failOnPut === this.putCount) throw new Error('synthetic storage interruption');
    this.objects.set(key, { buffer:bytes(buffer), contentType });
    return `memory://${key}`;
  }
  async get(key) { const value = this.objects.get(key); return value ? { buffer:value.buffer.slice(), contentType:value.contentType } : null; }
  async del(key) { this.objects.delete(key); }
  keys() { return [...this.objects.keys()].sort(); }
  has(key) { return this.objects.has(key); }
  setBytes(key, value, contentType='application/octet-stream') { this.objects.set(key, { buffer:bytes(value), contentType }); }
}

const TEST_POLICY = { raw_inline_safe_bytes:16, compressed_inline_safe_chars:96, stage_chunk_bytes:32, min_compression_savings_ratio:0.10, max_content_bytes:2_000_000 };
const T0 = '2026-08-28T17:00:00.000Z';
function nowAt(iso) { return () => new Date(iso); }
function id(number) { return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`; }
function manifestKey(identifier) { return `tmp/github-content-transport/${identifier}/manifest.json`; }
function chunkKey(identifier, index) { return `tmp/github-content-transport/${identifier}/${String(index).padStart(3, '0')}.bin`; }
function parseStoredJson(stored) { return JSON.parse(new TextDecoder().decode(stored.buffer)); }
async function loadManifest(storage, identifier) { const stored = await storage.get(manifestKey(identifier)); check(stored?.buffer, 'manifest missing'); return parseStoredJson(stored); }
async function saveManifest(storage, identifier, manifest) { await storage.put(manifestKey(identifier), new TextEncoder().encode(JSON.stringify(manifest)), 'application/json; charset=utf-8'); }

function semanticRequest(change) {
  return {
    repo:'owner/repo', base_ref:'main', branch:'feat/content-transport', expected_head:'0123456789abcdef0123456789abcdef01234567',
    changes:[{ path:'generated.txt', operation:'create', ...change }], commit_message:'Add generated content', idempotency_key:'semantic-test', lease_token:'opaque-lease',
  };
}

export async function runGithubTextTransportSpec() {
  const results = [];

  results.push(await run('transport selector deterministically covers raw, gzip-inline, staged identity, and staged gzip', async () => {
    check((await selectGithubTextTransport('hello\n', TEST_POLICY)).mode === 'raw-inline', 'small content did not stay raw inline');
    check((await selectGithubTextTransport('a'.repeat(200), TEST_POLICY)).mode === 'gzip-inline', 'compressible content did not select gzip inline');
    const noise = await selectGithubTextTransport(deterministicNoise(512), TEST_POLICY);
    check(noise.mode === 'staged' && noise.stage_encoding === 'identity', 'incompressible content did not select identity staging');
    const repeated = await selectGithubTextTransport('abcdefghij'.repeat(400), { ...TEST_POLICY, compressed_inline_safe_chars:16 });
    check(repeated.mode === 'staged' && repeated.stage_encoding === 'gzip', 'large compressible content did not select gzip staging');
  }));

  results.push(await run('opaque references round-trip raw and compressed-inline content without exposing transport choices', async () => {
    for (const fixture of [
      { content:'hello\n', identifier:id(1), expectedMode:'raw-inline' },
      { content:'a'.repeat(200), identifier:id(2), expectedMode:'gzip-inline' },
    ]) {
      const storage = new FakeStorage();
      const prepared = await prepareGithubContentReference(fixture.content, { storage, policy:TEST_POLICY, now:nowAt(T0), idFactory:()=>fixture.identifier });
      check(prepared.content_ref === `gct1_${fixture.identifier}`, 'opaque reference shape changed');
      check(!('mode' in prepared) && !('chunks' in prepared) && !('encoding' in prepared), 'prepare response leaked transport protocol details');
      check((await loadManifest(storage, fixture.identifier)).mode === fixture.expectedMode, 'mechanical selection was not retained internally');
      check(await resolveGithubContentReference(prepared.content_ref, { storage, now:nowAt(T0) }) === fixture.content, 'content reference did not resolve exact text');
    }
  }));

  results.push(await run('staged references reconstruct bounded chunks and exact UTF-8', async () => {
    const storage = new FakeStorage();
    const identifier = id(3);
    const content = 'reconstruct-me-'.repeat(300);
    const prepared = await prepareGithubContentReference(content, { storage, policy:{ ...TEST_POLICY, compressed_inline_safe_chars:16 }, now:nowAt(T0), idFactory:()=>identifier });
    const manifest = await loadManifest(storage, identifier);
    check(manifest.mode === 'staged' && manifest.stage_encoding === 'gzip', 'fixture did not stage compressed content');
    check(manifest.chunks.length > 1 && manifest.chunks.every(chunk => chunk.size <= TEST_POLICY.stage_chunk_bytes), 'staged chunks exceeded configured bound');
    check(await resolveGithubContentReference(prepared.content_ref, { storage, now:nowAt(T0) }) === content, 'staged content did not reconstruct exact text');
  }));

  results.push(await run('missing and corrupted staged chunks fail closed', async () => {
    const content = deterministicNoise(512);
    const missingStorage = new FakeStorage();
    const missingId = id(4);
    const missing = await prepareGithubContentReference(content, { storage:missingStorage, policy:TEST_POLICY, now:nowAt(T0), idFactory:()=>missingId });
    await missingStorage.del(chunkKey(missingId, 1));
    await expectError(resolveGithubContentReference(missing.content_ref, { storage:missingStorage, now:nowAt(T0) }), 'CONTENT_REF_CHUNK_MISSING');

    const corruptStorage = new FakeStorage();
    const corruptId = id(5);
    const corrupt = await prepareGithubContentReference(content, { storage:corruptStorage, policy:TEST_POLICY, now:nowAt(T0), idFactory:()=>corruptId });
    const original = await corruptStorage.get(chunkKey(corruptId, 0));
    const changed = original.buffer.slice(); changed[0] ^= 0xff; corruptStorage.setBytes(chunkKey(corruptId, 0), changed);
    await expectError(resolveGithubContentReference(corrupt.content_ref, { storage:corruptStorage, now:nowAt(T0) }), 'CONTENT_REF_CHUNK_CHECKSUM_MISMATCH');
  }));

  results.push(await run('reordered or duplicated staged manifest entries fail closed', async () => {
    const content = deterministicNoise(512);
    const reorderedStorage = new FakeStorage();
    const reorderedId = id(6);
    const reordered = await prepareGithubContentReference(content, { storage:reorderedStorage, policy:TEST_POLICY, now:nowAt(T0), idFactory:()=>reorderedId });
    const reorderedManifest = await loadManifest(reorderedStorage, reorderedId);
    [reorderedManifest.chunks[0], reorderedManifest.chunks[1]] = [reorderedManifest.chunks[1], reorderedManifest.chunks[0]];
    await saveManifest(reorderedStorage, reorderedId, reorderedManifest);
    await expectError(resolveGithubContentReference(reordered.content_ref, { storage:reorderedStorage, now:nowAt(T0) }), 'CONTENT_REF_INVALID_MANIFEST');

    const duplicateStorage = new FakeStorage();
    const duplicateId = id(7);
    const duplicate = await prepareGithubContentReference(content, { storage:duplicateStorage, policy:TEST_POLICY, now:nowAt(T0), idFactory:()=>duplicateId });
    const duplicateManifest = await loadManifest(duplicateStorage, duplicateId);
    duplicateManifest.chunks[1].index = duplicateManifest.chunks[0].index;
    await saveManifest(duplicateStorage, duplicateId, duplicateManifest);
    await expectError(resolveGithubContentReference(duplicate.content_ref, { storage:duplicateStorage, now:nowAt(T0) }), 'CONTENT_REF_INVALID_MANIFEST');
  }));

  results.push(await run('expired references are semantically stale and cleaned up best-effort', async () => {
    const storage = new FakeStorage();
    const identifier = id(8);
    const prepared = await prepareGithubContentReference(deterministicNoise(512), { storage, policy:TEST_POLICY, now:nowAt(T0), idFactory:()=>identifier });
    await expectError(resolveGithubContentReference(prepared.content_ref, { storage, now:nowAt('2026-08-28T18:00:01.000Z') }), 'CONTENT_REF_EXPIRED');
    check(!storage.has(manifestKey(identifier)), 'expired manifest was not cleaned up');
  }));

  results.push(await run('interrupted staged preparation never publishes a usable partial reference', async () => {
    const storage = new FakeStorage(); storage.failOnPut = 2;
    await expectError(prepareGithubContentReference(deterministicNoise(512), { storage, policy:TEST_POLICY, now:nowAt(T0), idFactory:()=>id(9) }), 'CONTENT_REF_STAGE_WRITE_FAILED');
    check(storage.keys().length === 0, `interrupted preparation left ${storage.keys().length} temporary objects`);
    storage.failOnPut = null;
    const retry = await prepareGithubContentReference(deterministicNoise(512), { storage, policy:TEST_POLICY, now:nowAt(T0), idFactory:()=>id(10) });
    check((await resolveGithubContentReference(retry.content_ref, { storage, now:nowAt(T0) })).length === 512, 'retry did not produce a usable reference');
  }));

  results.push(await run('raw, legacy gzip, and opaque references produce one semantic request hash', async () => {
    const content = 'semantic-content-αβγ\n'.repeat(100);
    const rawHash = await githubChangesetSemanticRequestHash(semanticRequest({ content }));
    const compressed = await selectGithubTextTransport(content, { ...TEST_POLICY, raw_inline_safe_bytes:1, compressed_inline_safe_chars:4096 });
    check(compressed.mode === 'gzip-inline', 'semantic fixture did not produce legacy gzip');
    const gzipHash = await githubChangesetSemanticRequestHash(semanticRequest({ content_gzip_base64:compressed.content_gzip_base64 }));

    const storage = new FakeStorage();
    const first = await prepareGithubContentReference(content, { storage, policy:{ ...TEST_POLICY, compressed_inline_safe_chars:16 }, now:nowAt(T0), idFactory:()=>id(11) });
    const firstExpanded = await expandGithubContentReferences(semanticRequest({ content_ref:first.content_ref }), { storage, now:nowAt(T0) });
    const firstHash = await githubChangesetSemanticRequestHash(firstExpanded);
    const second = await prepareGithubContentReference(content, { storage, policy:{ ...TEST_POLICY, compressed_inline_safe_chars:16 }, now:nowAt(T0), idFactory:()=>id(12) });
    const secondExpanded = await expandGithubContentReferences(semanticRequest({ content_ref:second.content_ref }), { storage, now:nowAt(T0) });
    const secondHash = await githubChangesetSemanticRequestHash(secondExpanded);
    check(rawHash === gzipHash && rawHash === firstHash && rawHash === secondHash, 'transport representation changed semantic request identity');
  }));

  results.push(await run('opaque staged content references round-trip Kubernetes-sized text while retaining a bounded maximum', async () => {
    const storage = new FakeStorage();
    const identifier = id(13);
    const content = 'x'.repeat(4_036_632);
    const prepared = await prepareGithubContentReference(content, {
      storage,
      policy:{ raw_inline_safe_bytes:16, compressed_inline_safe_chars:16, stage_chunk_bytes:64 * 1024, min_compression_savings_ratio:0.10 },
      now:nowAt(T0),
      idFactory:()=>identifier,
    });
    const manifest = await loadManifest(storage, identifier);
    check(manifest.mode === 'staged', 'Kubernetes-sized fixture did not use staged content transport');
    check(manifest.content_bytes === 4_036_632, 'large content manifest lost exact byte identity');
    check(await resolveGithubContentReference(prepared.content_ref, { storage, now:nowAt(T0) }) === content, 'large staged content did not round-trip exact UTF-8');
    await expectError(prepareGithubContentReference('x'.repeat(10_000_001), { storage:new FakeStorage(), now:nowAt(T0), idFactory:()=>id(14) }), 'INVALID_CONTENT_TRANSPORT');
  }));

  results.push(await run('oversized stored content metadata still fails closed at reference resolution', async () => {
    const storage = new FakeStorage();
    const identifier = id(15);
    const prepared = await prepareGithubContentReference('hello\n', { storage, policy:TEST_POLICY, now:nowAt(T0), idFactory:()=>identifier });
    const manifest = await loadManifest(storage, identifier); manifest.content_bytes = 10_000_001; await saveManifest(storage, identifier, manifest);
    await expectError(resolveGithubContentReference(prepared.content_ref, { storage, now:nowAt(T0) }), 'CONTENT_REF_CONTENT_TOO_LARGE');
  }));

  return results;
}