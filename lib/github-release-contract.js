import { semanticCommandDescriptor } from './semantic-command-descriptors.js';
const descriptor = semanticCommandDescriptor('github.release.create');
export const GITHUB_RELEASE_SEMANTIC_FIELDS = descriptor.semantic_fields;
export const GITHUB_RELEASE_REQUIRED_FIELDS = descriptor.required_fields;
export const GITHUB_RELEASE_INPUT_SCHEMA = descriptor.input_schema;
