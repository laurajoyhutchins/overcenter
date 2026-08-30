import {
  semanticCommandDescriptorsForSurface,
  semanticMcpDiscoveryForSurface,
} from '../src/semantic/semantic-command-descriptors';

const primary = semanticCommandDescriptorsForSurface('primary');

const primaryCommands: readonly string[] = primary.map((descriptor) => descriptor.command);
void primaryCommands;

const primaryMcpDiscovery = semanticMcpDiscoveryForSurface('primary');
const primaryMcpNames: readonly string[] = primaryMcpDiscovery.map((tool) => tool.name);
const primarySchemas: readonly Readonly<Record<string, unknown>>[] = primaryMcpDiscovery.map((tool) => tool.input_schema);
void primaryMcpNames;
void primarySchemas;

// @ts-expect-error discovery projection must remain immutable
primary.push(primary[0]!);

// @ts-expect-error MCP discovery projection must remain immutable
primaryMcpDiscovery.push(primaryMcpDiscovery[0]!);

// @ts-expect-error discovery surface must reject unknown exposure classes
semanticCommandDescriptorsForSurface('ordinary');

// @ts-expect-error MCP discovery must reject unknown exposure classes
semanticMcpDiscoveryForSurface('ordinary');