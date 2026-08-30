export async function promoteProduction(intent, ports) {
  const roles = await ports.resolveBranchRoles(intent.repo);
  const sourceRevision = await ports.readBranchHead(intent.repo, roles.development);
  const productionRevision = await ports.readBranchHead(intent.repo, roles.production);
  const verification = await ports.verifyExactRevision(intent.repo, sourceRevision);

  if (
    !verification.verified
    || verification.revision !== sourceRevision
    || verification.verification_ref.trim().length === 0
  ) {
    throw new Error('PRODUCTION_PROMOTION_SOURCE_NOT_VERIFIED');
  }

  return ports.promoteVerifiedRevision({
    repo:intent.repo,
    source_revision:sourceRevision,
    production_revision:productionRevision,
    verification_ref:verification.verification_ref,
  });
}