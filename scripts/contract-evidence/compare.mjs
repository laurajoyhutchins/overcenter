export function compareUnclassified(baseIds = [], headIds = []) {
  const base = new Set(baseIds);
  const head = new Set(headIds);
  const newUnclassified = [...head].filter((id) => !base.has(id)).sort();
  const removedUnclassified = [...base].filter((id) => !head.has(id)).sort();
  return Object.freeze({
    ok:newUnclassified.length === 0,
    new_unclassified:Object.freeze(newUnclassified),
    removed_unclassified:Object.freeze(removedUnclassified),
  });
}

export function compareCatalogs(base, head) {
  const ratchet = compareUnclassified(
    base?.unclassified_source_identities || [],
    head?.unclassified_source_identities || [],
  );
  const baseContracts = new Map((base?.logical_contracts || []).map((item) => [item.id, item]));
  const headContracts = new Map((head?.logical_contracts || []).map((item) => [item.id, item]));
  const changedContracts = [];

  for (const id of [...headContracts.keys()].filter((value) => baseContracts.has(value)).sort()) {
    const before = baseContracts.get(id);
    const after = headContracts.get(id);
    const baseFingerprint = before?.authority?.structural_fingerprint || null;
    const headFingerprint = after?.authority?.structural_fingerprint || null;
    if (baseFingerprint === headFingerprint) continue;
    changedContracts.push(Object.freeze({
      logical_contract:id,
      ...(after?.authority?.semver_kind || before?.authority?.semver_kind
        ? { semver_kind:after?.authority?.semver_kind || before?.authority?.semver_kind }
        : {}),
      base_fingerprint:baseFingerprint,
      head_fingerprint:headFingerprint,
      changed:true,
    }));
  }

  return Object.freeze({
    ok:ratchet.ok,
    new_unclassified:ratchet.new_unclassified,
    removed_unclassified:ratchet.removed_unclassified,
    added_contracts:Object.freeze([...headContracts.keys()].filter((id) => !baseContracts.has(id)).sort()),
    removed_contracts:Object.freeze([...baseContracts.keys()].filter((id) => !headContracts.has(id)).sort()),
    changed_contracts:Object.freeze(changedContracts),
  });
}
