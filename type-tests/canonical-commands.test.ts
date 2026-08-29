import { CANONICAL_COMMANDS } from '../src/semantic/canonical-commands.js';
import type { CanonicalCommand } from '../src/semantic/command-contracts.js';

const claimCommand: CanonicalCommand = 'work.claim';
const applyChangesetCommand: CanonicalCommand = 'github.apply_changeset';
void claimCommand;
void applyChangesetCommand;

const canonicalCommands: readonly CanonicalCommand[] = CANONICAL_COMMANDS;
void canonicalCommands;

// @ts-expect-error Unknown command names must not enter the canonical command union.
const unknownCommand: CanonicalCommand = 'github.do_whatever';
void unknownCommand;