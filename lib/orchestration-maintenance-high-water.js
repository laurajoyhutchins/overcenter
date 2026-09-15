const MAINTENANCE_KEY = 'orchestration.maintain';
const GIT_REVISION = /^[0-9a-f]{40}$/;
const UTC_HOURLY_EPOCH = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/;

function invalidIdentity(message, details = {}) {
  const error = new TypeError(message);
  error.code = 'ORCHESTRATION_MAINTENANCE_IDENTITY_INVALID';
  error.details = details;
  return error;
}

function normalizeStoredEpoch(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function normalizeMaintenanceIdentity(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidIdentity('maintenance identity must be an object');
  }

  const authoritativeRevision = typeof value.authoritative_revision === 'string'
    ? value.authoritative_revision.trim()
    : '';
  const timedMaintenanceEpoch = typeof value.timed_maintenance_epoch === 'string'
    ? value.timed_maintenance_epoch.trim()
    : '';
  const parsedEpoch = new Date(timedMaintenanceEpoch);

  if (!GIT_REVISION.test(authoritativeRevision)) {
    throw invalidIdentity('authoritative_revision must be an exact 40-character lowercase Git revision', {
      field:'authoritative_revision',
    });
  }
  if (!UTC_HOURLY_EPOCH.test(timedMaintenanceEpoch)
      || Number.isNaN(parsedEpoch.getTime())
      || parsedEpoch.toISOString() !== timedMaintenanceEpoch) {
    throw invalidIdentity('timed_maintenance_epoch must be an exact UTC hourly epoch', {
      field:'timed_maintenance_epoch',
    });
  }

  return Object.freeze({
    authoritative_revision:authoritativeRevision,
    timed_maintenance_epoch:timedMaintenanceEpoch,
  });
}

async function readHighWater(db) {
  const result = await db.query(
    `SELECT authoritative_revision,timed_maintenance_epoch,maintained_at
       FROM orchestration_maintenance_high_water
      WHERE maintenance_key=$1
      LIMIT 1`,
    [MAINTENANCE_KEY],
  );
  return result?.rows?.[0] || null;
}

async function recordHighWater(db, identity, maintainedAt) {
  const result = await db.query(
    `INSERT INTO orchestration_maintenance_high_water
       (maintenance_key,authoritative_revision,timed_maintenance_epoch,maintained_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (maintenance_key) DO UPDATE SET
       authoritative_revision=EXCLUDED.authoritative_revision,
       timed_maintenance_epoch=EXCLUDED.timed_maintenance_epoch,
       maintained_at=EXCLUDED.maintained_at
     RETURNING authoritative_revision,timed_maintenance_epoch,maintained_at`,
    [MAINTENANCE_KEY, identity.authoritative_revision, identity.timed_maintenance_epoch, maintainedAt],
  );
  return result?.rows?.[0] || null;
}

function unchanged(highWater, identity) {
  return highWater?.authoritative_revision === identity.authoritative_revision
    && normalizeStoredEpoch(highWater?.timed_maintenance_epoch) === identity.timed_maintenance_epoch;
}

export function createHighWaterOrchestrationMaintenanceService({
  db,
  delegate,
  maintenanceIdentity = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!delegate || typeof delegate.maintain !== 'function') throw new TypeError('delegate maintenance service is required');
  const identity = normalizeMaintenanceIdentity(maintenanceIdentity);
  if (!identity) return delegate;
  if (!db || typeof db.query !== 'function') throw new TypeError('db is required for maintenance high-water tracking');

  return Object.freeze({
    async maintain() {
      const highWater = await readHighWater(db);
      if (unchanged(highWater, identity)) {
        return Object.freeze({
          ok:true,
          schema:'orchestration-maintenance-v1',
          skipped:true,
          skip_reason:'HIGH_WATER_UNCHANGED',
          authoritative_revision:identity.authoritative_revision,
          timed_maintenance_epoch:identity.timed_maintenance_epoch,
          actions:[],
          action_count:0,
          semantic_work_mutations:0,
          work_selection_performed:false,
        });
      }

      const result = await delegate.maintain();
      if (result?.ok !== true) return result;

      await recordHighWater(db, identity, now());
      return Object.freeze({
        ...result,
        skipped:false,
        authoritative_revision:identity.authoritative_revision,
        timed_maintenance_epoch:identity.timed_maintenance_epoch,
      });
    },
  });
}
