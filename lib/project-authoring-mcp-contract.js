import { semanticCommandDescriptor } from './semantic-command-descriptors.js';

export const PROJECT_DEFINE_INPUT_SCHEMA = semanticCommandDescriptor('project.define').input_schema;
export const PROJECT_AMEND_INPUT_SCHEMA = semanticCommandDescriptor('project.amend').input_schema;
export const PROJECT_ADD_OBLIGATION_INPUT_SCHEMA = semanticCommandDescriptor('project.add_obligation').input_schema;