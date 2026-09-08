import { createServer } from 'node:http';
import pg from 'pg';

const FREEZE_AT = '2026-09-08T02:35:29.376Z';
const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const VALID_SCHEMA = 'project-transition-lease-settlement-v1';
const { Pool } = pg;
const pool = new Pool();

const commonPredicate = `
  status='settled'
  AND claim_receipt->>'subject'='project_transition'
  AND settle_receipt->>'subject'='project_transition'
  AND settle_receipt->>'disposition'='completed'
  AND settle_receipt->'project_transition'->>'project_ref'=$1
`;

function send(res, status, body) {
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(body)}\n`);
}

async function malformedSettlements() {
  return pool.query(
    `SELECT lease_id::text AS lease_ref,
            run_id,
            settled_at,
            COALESCE(settle_receipt->>'schema','') AS receipt_schema,
            settle_receipt->'project_transition'->>'transition_id' AS transition_id,
            settle_receipt->'project_transition'->>'authority_revision' AS authority_revision
       FROM work_leases
      WHERE ${commonPredicate}
        AND COALESCE(settle_receipt->>'schema','') <> $2
      ORDER BY settled_at ASC, lease_id ASC`,
    [PROJECT_REF, VALID_SCHEMA],
  );
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      await pool.query('SELECT 1');
      return send(res, 200, { ok:true, database:'ready' });
    }
    if (req.method === 'GET' && req.url === '/inspect-all') {
      const result = await malformedSettlements();
      return send(res, 200, {
        ok:true,
        project_ref:PROJECT_REF,
        freeze_at:FREEZE_AT,
        malformed_count:result.rowCount,
        malformed:result.rows.map(row => ({
          ...row,
          epoch: Date.parse(String(row.settled_at)) <= Date.parse(FREEZE_AT) ? 'pre_freeze' : 'post_freeze',
        })),
      });
    }
    return send(res, 404, { ok:false, error:'not_found' });
  } catch (error) {
    return send(res, 500, { ok:false, error:String(error?.code || error?.message || error) });
  }
});

const port = Number(process.env.PORT || 8080);
server.listen(port, '0.0.0.0');
