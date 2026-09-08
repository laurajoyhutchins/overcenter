import { createServer } from 'node:http';
import pg from 'pg';

const FREEZE_AT = '2026-09-08T02:35:29.376Z';
const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const VALID_SCHEMA = 'project-transition-lease-settlement-v1';
const { Pool } = pg;
const pool = new Pool();

const predicate = `
  status='settled'
  AND settled_at <= $1::timestamptz
  AND claim_receipt->>'subject'='project_transition'
  AND settle_receipt->>'subject'='project_transition'
  AND settle_receipt->>'disposition'='completed'
  AND settle_receipt->'project_transition'->>'project_ref'=$2
  AND COALESCE(settle_receipt->>'schema','') <> $3
`;
const params = [FREEZE_AT, PROJECT_REF, VALID_SCHEMA];

function send(res, status, body) {
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(body)}\n`);
}

async function candidates(client = pool) {
  return client.query(
    `SELECT lease_id::text AS lease_ref, run_id, settled_at, COALESCE(settle_receipt->>'schema','') AS receipt_schema
       FROM work_leases
      WHERE ${predicate}
      ORDER BY settled_at ASC, lease_id ASC`,
    params,
  );
}

async function repair() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const observed = await client.query(
      `SELECT lease_id::text AS lease_ref, run_id, settled_at
         FROM work_leases
        WHERE ${predicate}
        ORDER BY settled_at ASC, lease_id ASC
        FOR UPDATE`,
      params,
    );
    const leaseIds = observed.rows.map(row => row.lease_ref);
    let deletedSlots = 0;
    if (leaseIds.length > 0) {
      const slots = await client.query('DELETE FROM work_lease_slots WHERE lease_id = ANY($1::uuid[])', [leaseIds]);
      deletedSlots = slots.rowCount;
    }
    const deleted = await client.query(
      `DELETE FROM work_leases WHERE ${predicate} RETURNING lease_id::text AS lease_ref`,
      params,
    );
    if (deleted.rowCount !== observed.rowCount) {
      throw new Error(`candidate/delete count drifted: ${observed.rowCount} -> ${deleted.rowCount}`);
    }
    await client.query('COMMIT');
    return {
      ok:true,
      project_ref:PROJECT_REF,
      freeze_at:FREEZE_AT,
      deleted_lease_count:deleted.rowCount,
      deleted_slot_count:deletedSlots,
      deleted_lease_refs:deleted.rows.map(row => row.lease_ref),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      await pool.query('SELECT 1');
      return send(res, 200, { ok:true, database:'ready' });
    }
    if (req.method === 'GET' && req.url === '/inspect') {
      const result = await candidates();
      return send(res, 200, {
        ok:true,
        project_ref:PROJECT_REF,
        freeze_at:FREEZE_AT,
        candidate_count:result.rowCount,
        candidates:result.rows,
      });
    }
    if (req.method === 'POST' && req.url === '/repair') {
      return send(res, 200, await repair());
    }
    return send(res, 404, { ok:false, error:'not_found' });
  } catch (error) {
    return send(res, 500, { ok:false, error:String(error?.code || error?.message || error) });
  }
});

const port = Number(process.env.PORT || 8080);
server.listen(port, '0.0.0.0');
