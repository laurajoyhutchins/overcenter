import { semanticCommandDescriptor } from './semantic-command-descriptors.js';

export const PROJECT_DEFINE_INPUT_SCHEMA = semanticCommandDescriptor('project.define').input_schema;
export const PROJECT_AMEND_INPUT_SCHEMA = semanticCommandDescriptor('project.amend').input_schema;
export const PROJECT_ADD_CONVERSATION_INPUT_SCHEMA = Object.freeze({
  type:'object',
  required:['project_ref','expected_revision','conversation','amendment'],
  properties:{
    project_ref:{type:'string',pattern:'^github:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'},
    expected_revision:{type:'string',pattern:'^[0-9a-fA-F]{40}$'},
    conversation:{
      type:'object',
      required:['text'],
      properties:{
        text:{type:'string',minLength:1,maxLength:125000},
        citations:{
          type:'array',
          maxItems:128,
          items:{
            type:'object',
            required:['kind','ref'],
            properties:{kind:{type:'string',minLength:1},ref:{type:'string',minLength:1}},
            additionalProperties:false,
          },
        },
      },
      additionalProperties:false,
    },
    amendment:{type:'object'},
  },
  additionalProperties:false,
});