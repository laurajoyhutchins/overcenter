import pg from 'pg';

const FREEZE_AT = '2026-09-08T02:35:29.376Z';
const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const VALID_SCHEMA = 'project-transition-lease-settlement-v1';

const { Pool } = pg;
const pool = new Pool();
const client = await pool.connect();

const predicate = `
  status='settled'
  AND settled_at <= $1::timestamptz
  AND claim_receipt->>'subject'='project_transition'
  AND settle_receipt->>'subject'='project_transition'
  AND settle_receipt->>'disposition'='completed'
  AND settle_receipt->'project_transition'->>'project_ref'=$2
  AND COALESCE(settle_receipt->>'schema','') <> $3
`;

try {
  await client.query('BEGIN');

  const candidates = await client.query(
    `SELECT lease_id::text AS lease_ref, run_id, settled_at
       FROM work_leases
      WHERE ${predicate}
      ORDER BY settled_at ASC, lease_id ASC
      FOR UPDATE`,
    [FREEZE_AT, PROJECT_REF, VALID_SCHEMA],
  );

  const leaseIds = candidates.rows.map(row => row.lease_ref);
  let deletedSlots = 0;
  if (leaseIds.length > 0) {
    const slots = await client.query(
      'DELETE FROM work_lease_slots WHERE lease_id = ANY($1::uuid[])',
      [leaseIds],
    );
    deletedSlots = slots.rowCount;
  }

  const deleted = await client.query(
    `DELETE FROM work_leases
      WHERE ${predicate}
      RETURNING lease_id::text AS lease_ref, run_id, settled_at`,
    [FREEZE_AT, PROJECT_REF, VALID_SCHEMA],
  );

  if (deleted.rowCount !== candidates.rowCount) {
    throw new Error(`candidate/delete count drifted: ${candidates.rowCount} -> ${deleted.rowCount}`);
  }

  await client.query('COMMIT');
  console.log(JSON.stringify({
    ok:true,
    project_ref:PROJECT_REF,
    freeze_at:FREEZE_AT,
    deleted_lease_count:deleted.rowCount,
    deleted_slot_count:deletedSlots,
    deleted_lease_refs:deleted.rows.map(row => row.lease_ref),
  }));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
