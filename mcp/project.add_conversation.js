import { db as hatchableDb } from 'hatchable';
import { projectAuthoringFor } from 'lib/project-authoring-overcenter-host.js';
import { PROJECT_ADD_CONVERSATION_INPUT_SCHEMA } from 'lib/project-authoring-mcp-contract.js';
import { addConversationToProject } from 'lib/project-conversation-authoring.js';

export const access = 'admin';
export default {
  name:'project.add_conversation',
  description:'Apply explicit conversation-derived graph judgment through canonical project authoring. The reasoning layer supplies the semantic amendment and bounded conversation provenance; the deterministic graph kernel validates and applies that amendment at an exact Git authority revision and returns authoritative diff/readback evidence.',
  inputSchema:PROJECT_ADD_CONVERSATION_INPUT_SCHEMA,
  async handler(args,ctx) {
    const db = ctx?.db || hatchableDb;
    return addConversationToProject(args || {}, projectAuthoringFor({ db }));
  },
};
