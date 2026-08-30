import { pathToFileURL } from 'node:url';
import {
  MIGRATED_SEMANTIC_COMMANDS,
  semanticCommandDescriptor,
} from '../lib/semantic-command-descriptors.js';

function codeList(values) {
  return values.length ? values.map((value) => `\`${value}\``).join(', ') : '_none_';
}

export function renderSemanticCommandReference() {
  const lines = [
    '# Semantic command descriptors',
    '',
    '> Generated from the typed semantic descriptor source. Do not edit command metadata here by hand.',
    '',
  ];

  for (const command of [...MIGRATED_SEMANTIC_COMMANDS].sort()) {
    const descriptor = semanticCommandDescriptor(command);
    lines.push(
      `## ${descriptor.command}`,
      '',
      descriptor.description,
      '',
      `- MCP name: \`${descriptor.mcp_name}\``,
      `- Agent surface: \`${descriptor.surface}\``,
      `- Required fields: ${codeList(descriptor.required_fields)}`,
      `- Semantic fields: ${codeList(descriptor.semantic_fields)}`,
      `- Exposure: worker=${descriptor.exposure.worker ? 'yes' : 'no'}, MCP=${descriptor.exposure.mcp ? 'yes' : 'no'}`,
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.stdout.write(renderSemanticCommandReference());
}