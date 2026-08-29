import { CANONICAL_COMMANDS } from './command-response.js';
import type { SemanticIdentity } from './semantic-identities.js';

export type CanonicalCommand = SemanticIdentity<'CanonicalCommand'>;

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