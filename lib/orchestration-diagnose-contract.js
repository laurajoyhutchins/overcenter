import { semanticCommandDescriptor } from './semantic-command-descriptors.js';
const descriptor = semanticCommandDescriptor('orchestration.diagnose');
export const ORCHESTRATION_DIAGNOSE_INPUT_SCHEMA = descriptor.input_schema;
export const ORCHESTRATION_DIAGNOSE_SEMANTIC_FIELDS = descriptor.semantic_fields;
export const ORCHESTRATION_DIAGNOSE_REQUIRED_FIELDS = descriptor.required_fields;
