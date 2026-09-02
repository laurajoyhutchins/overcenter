function coordinate(candidate) {
  const path = candidate?.source_location?.path;
  const anchor = candidate?.source_location?.anchor || candidate?.symbol_or_boundary;
  return path ? `${path}${anchor ? `#${anchor}` : ''}` : null;
}

export function renderAuthorityAtlasMarkdown(catalog) {
  const candidates = new Map((catalog?.candidates || []).map((candidate) => [candidate.source_identity, candidate]));
  const logicalContracts = [...(catalog?.logical_contracts || [])]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const lines = [
    '# Contract authority atlas',
    '',
    'Generated from contract evidence. Edit authoritative sources or classification metadata, not this file.',
    '',
    'This atlas shows mechanically evidenced logical-contract authority and manifestations. It does not infer consumer or cross-contract flow relationships that the catalog does not encode.',
    '',
  ];

  for (const logical of logicalContracts) {
    const authority = logical.authority || {};
    const authorityCandidate = candidates.get(authority.source_identity);
    lines.push(`## \`${logical.id}\``, '');
    lines.push(`- Significance: \`${authority.significance || 'unclassified'}\``);
    if (authority.semver_kind) lines.push(`- SemVer: \`${authority.semver_kind}\``);
    lines.push(`- Authority: \`${authority.source_identity}\` (\`${authority.source_kind}\`)`);
    const authoritySource = coordinate(authorityCandidate);
    if (authoritySource) lines.push(`- Authority source: \`${authoritySource}\``);

    const projections = [...(logical.projections || [])]
      .sort((left, right) => String(left.source_identity).localeCompare(String(right.source_identity)));
    lines.push(`- Manifestations: ${1 + projections.length}`, '', '### Projections', '');
    if (!projections.length) {
      lines.push('_None._', '');
      continue;
    }
    for (const projection of projections) {
      lines.push(`- \`${projection.source_identity}\` (\`${projection.source_kind}\`)`);
      const source = coordinate(candidates.get(projection.source_identity));
      if (source) lines.push(`  - Source: \`${source}\``);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}