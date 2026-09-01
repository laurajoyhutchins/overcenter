import { pathToFileURL } from 'node:url';
import {
  SEMANTIC_COMMAND_SURFACES,
  semanticCommandDescriptor,
  semanticMcpDiscoveryForSurface,
} from '../lib/semantic-command-descriptors.js';

function codeList(values) {
  return values.length ? values.map((value) => `\`${value}\``).join(', ') : '_none_';
}

function surfaceTitle(surface) {
  return `${surface[0].toUpperCase()}${surface.slice(1)} surface`;
}

export function renderSemanticCommandReference() {
  const lines = [
    '# Semantic command descriptors',
    '',
    '> Generated from the typed semantic descriptor source. Only the primary product surface is MCP-discoverable to ordinary agents; advanced, operator, and compatibility commands remain runtime capabilities without top-level MCP registration.',
    '',
  ];

  for (const surface of SEMANTIC_COMMAND_SURFACES) {
    const discovery = semanticMcpDiscoveryForSurface(surface);
    lines.push(`## ${surfaceTitle(surface)}`, '');
    if (!discovery.length) {
      lines.push('_No MCP-exposed commands._', '');
      continue;
    }
    for (const tool of [...discovery].sort((left, right) => left.command.localeCompare(right.command))) {
      const descriptor = semanticCommandDescriptor(tool.command);
      lines.push(
        `### ${descriptor.command}`,
        '',
        descriptor.description,
        '',
        `- MCP name: \`${tool.name}\``,
        `- Required fields: ${codeList(descriptor.required_fields)}`,
        `- Semantic fields: ${codeList(descriptor.semantic_fields)}`,
        `- Exposure: worker=${descriptor.exposure.worker ? 'yes' : 'no'}, MCP=${descriptor.exposure.mcp ? 'yes' : 'no'}`,
        '',
      );
    }
  }
  return lines.join('\n').trimEnd();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.stdout.write(renderSemanticCommandReference());
}