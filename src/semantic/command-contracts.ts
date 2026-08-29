import { CANONICAL_COMMANDS } from './canonical-commands.js';
import type { CanonicalCommand } from './canonical-commands.js';

export type { CanonicalCommand } from './canonical-commands.js';

const COMMAND_SET = new Set<string>(CANONICAL_COMMANDS);

export function isCanonicalCommand(value: string): value is CanonicalCommand {
  return COMMAND_SET.has(value);
}

export function parseCanonicalCommand(value: string): CanonicalCommand {
  if (!isCanonicalCommand(value)) {
    throw new Error(`Unsupported canonical command: ${value}`);
  }
  return value;
}