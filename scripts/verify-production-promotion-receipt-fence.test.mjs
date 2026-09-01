import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const probe = `
import { createGithubProductionPromotionReceiptStore } from './lib/github-production-promotion.js';
const updates=[];
const store=createGithubProductionPromotionReceiptStore({
  async query(sql, params) {
    updates.push({sql,params});
    return { rows:[], rowCount:0 };
  },
});
let error=null;
try {
  await store.succeed(
    {repo:'laurajoyhutchins/overcenter',idempotency_key:'promotion:test:fence'},
    '00000000-0000-4000-8000-000000000001',
    {new_production_head:'b'.repeat(40)},
  );
} catch (caught) {
  error=caught;
}
if (!error) throw new Error('stale promotion receipt attempt settled without owning the fence');
if (error.code !== 'GITHUB_PRODUCTION_PROMOTION_RECEIPT_FENCE_LOST') throw error;
if (!updates[0]?.sql.includes("state='processing'")) throw new Error('receipt settlement did not fence processing state');
if (!updates[0]?.sql.includes('RETURNING')) throw new Error('receipt settlement cannot prove its fenced update');
`;

test('production promotion receipt settlement fails closed when attempt-token authority is lost', () => {
  const result=spawnSync(process.execPath,[
    '--experimental-loader','./scripts/hatchable-node-test-loader.mjs',
    '--input-type=module','-e',probe,
  ],{cwd:process.cwd(),encoding:'utf8'});
  assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
});