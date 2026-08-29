import { CANONICAL_COMMANDS } from 'lib/command-response.js';
const COMMAND_SET = new Set(CANONICAL_COMMANDS);
export function isCanonicalCommand(value) {
    return COMMAND_SET.has(value);
}
export function parseCanonicalCommand(value) {
    if (!isCanonicalCommand(value)) {
        throw new Error(`Unsupported canonical command: ${value}`);
    }
    return value;
}