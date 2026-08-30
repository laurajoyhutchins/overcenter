import { pathToFileURL } from 'node:url';
import { semanticCommandDescriptorsForSurface } from '../lib/semantic-command-descriptors.js';

function codeList(values) {
  return values.length ? values.map((value) => `\`${value}\``).join(', ') : '_none_';
}

export function renderPrimarySemanticSurface() {
  const descriptors = [...semanticCommandDescriptorsForSurface('primary')]
    .sort((left, right) => left.command.localeCompare(right.command));
  const lines = [
    '# Primary agent surface',
    '',
    '> Generated from authoritative semantic command metadata. Ordinary agents should start here; advanced, operator, and compatibility commands remain available but are intentionally omitted from this entry surface.',
    '',
  ];

  for (const descriptor of descriptors) {
    lines.push(
      `## ${descriptor.command}`,
      '',
      descriptor.description,
      '',
      `- MCP name: \`${descriptor.mcp_name}\``,
      `- Required caller fields: ${codeList(descriptor.required_fields)}`,
      '',
    );
  }

  lines.push(
    '## Advancement boundary',
    '',
    '`orchestration.advance` is not yet classified as primary because its current caller contract requires a pre-existing `run_id`. The primary surface must not make run, horizon, lease, or settlement choreography an ordinary agent prerequisite. A future intent-level project advancement boundary should compose that machinery internally before it is promoted here.',
  );

  return lines.join('\n').trimEnd();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.stdout.write(renderPrimarySemanticSurface());
}
