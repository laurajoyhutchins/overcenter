import { semanticCommandDescriptor } from './semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('github.pull_request.mark_ready');

export const GITHUB_PULL_REQUEST_READY_SEMANTIC_FIELDS = descriptor.semantic_fields;
export const GITHUB_PULL_REQUEST_READY_REQUIRED_FIELDS = descriptor.required_fields;
export const GITHUB_PULL_REQUEST_READY_INPUT_SCHEMA = descriptor.input_schema;