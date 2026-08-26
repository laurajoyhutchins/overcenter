export const REPOSITORY_DISPOSITIONS = Object.freeze(['ACTIVE','MAINTENANCE','DORMANT','ARCHIVED','SUPERSEDED']);

export function initialRepositoryDisposition({ archived = false, existingDisposition = null } = {}) {
  if (existingDisposition !== null && existingDisposition !== undefined) {
    const disposition = String(existingDisposition).trim().toUpperCase();
    if (!REPOSITORY_DISPOSITIONS.includes(disposition)) {
      throw new TypeError(`unknown repository disposition: ${existingDisposition}`);
    }
    return disposition;
  }
  return archived === true ? 'ARCHIVED' : 'DORMANT';
}