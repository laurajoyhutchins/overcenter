import {
  semanticCommandDescriptorsForSurface,
} from '../src/semantic/semantic-command-descriptors';

const primary = semanticCommandDescriptorsForSurface('primary');

const primaryCommands: readonly string[] = primary.map((descriptor) => descriptor.command);
void primaryCommands;

// @ts-expect-error discovery projection must remain immutable
primary.push(primary[0]!);

// @ts-expect-error discovery surface must reject unknown exposure classes
semanticCommandDescriptorsForSurface('ordinary');
