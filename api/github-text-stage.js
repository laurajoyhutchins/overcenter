import { storage } from 'hatchable';

export const access = 'admin';
export const methods = ['POST'];

const ID = /^[A-Za-z0-9._-]{1,120}$/;
const SHA256 = /^[0-9a-f]{64}$/;

async function sha256Text(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export default async function (req, res) {
  const body = req.body || {};
  const stageId = String(body.stage_id || '');
  const index = Number(body.index);
  const totalChunks = Number(body.total_chunks);
  const chunk = body.chunk;
  const expectedSha = String(body.chunk_sha256 || '').toLowerCase();

  if (!ID.test(stageId)) return res.status(422).json({ ok: false, error: 'INVALID_STAGE_ID' });
  if (!Number.isInteger(index) || index < 0 || index >= 256) return res.status(422).json({ ok: false, error: 'INVALID_CHUNK_INDEX' });
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 256 || index >= totalChunks) return res.status(422).json({ ok: false, error: 'INVALID_CHUNK_COUNT' });
  if (typeof chunk !== 'string' || chunk.length < 1 || chunk.length > 16_384) return res.status(422).json({ ok: false, error: 'INVALID_CHUNK' });
  if (!SHA256.test(expectedSha)) return res.status(422).json({ ok: false, error: 'INVALID_CHUNK_SHA256' });

  const actualSha = await sha256Text(chunk);
  if (actualSha !== expectedSha) {
    return res.status(422).json({ ok: false, error: 'CHUNK_CHECKSUM_MISMATCH', index, expected_sha256: expectedSha, actual_sha256: actualSha });
  }

  const key = `github-text-stage/${stageId}/${String(index).padStart(3, '0')}.txt`;
  await storage.put(key, new TextEncoder().encode(chunk), 'text/plain; charset=utf-8');
  return res.json({ ok: true, stage_id: stageId, index, total_chunks: totalChunks, chunk_length: chunk.length, chunk_sha256: actualSha });
}