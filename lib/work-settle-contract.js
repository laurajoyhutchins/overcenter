import { semanticCommandDescriptor } from './semantic-command-descriptors.js';
const descriptor = semanticCommandDescriptor('work.settle');
export const WORK_SETTLE_INPUT_SCHEMA = descriptor.input_schema;
export const WORK_SETTLE_SEMANTIC_FIELDS = descriptor.semantic_fields;
export const WORK_SETTLE_REQUIRED_FIELDS = descriptor.required_fields;
