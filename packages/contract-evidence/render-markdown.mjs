const SECTIONS = Object.freeze([
  ['public', 'Public compatibility contracts'],
  ['authority', 'Authority/internal contracts'],
  ['durable-internal', 'Durable internal contracts'],
  ['boundary-internal', 'Boundary-internal contracts'],
  ['implementation-only', 'Implementation-only shapes'],
]);

function lineForContract(contract) {
  const authority = contract.authority || {};
  const details = [
    `authority \`${authority.source_identity || 'unknown'}\``,
    authority.semver_kind ? `SemVer \`${authority.semver_kind}\`` : null,
    contract.projections?.length ? `${contract.projections.length} projection${contract.projections.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join('; ');
  return `- \`${contract.id}\` — ${details}`;
}

export function renderCatalogMarkdown(catalog) {
  const lines = [
    '# Data contracts',
    '',
    '> Generated from contract evidence. Edit authoritative sources or classification metadata, not this file.',
    '',
  ];
  const contracts = [...(catalog?.logical_contracts || [])].sort((a, b) => a.id.localeCompare(b.id));

  for (const [significance, title] of SECTIONS) {
    lines.push(`## ${title}`, '');
    const group = contracts.filter((contract) => contract?.authority?.significance === significance);
    if (!group.length) lines.push('_None._', '');
    else for (const contract of group) lines.push(lineForContract(contract));
    if (group.length) lines.push('');
  }

  const unclassified = [...(catalog?.unclassified_source_identities || [])].sort();
  if (unclassified.length) {
    lines.push('## Unclassified historical debt', '');
    for (const sourceIdentity of unclassified) lines.push(`- \`${sourceIdentity}\``);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
