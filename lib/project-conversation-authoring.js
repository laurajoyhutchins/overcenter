import { normalizeProjectAddConversationRequest } from './project-authoring-command-contract.js';
function fail(message) {
    const error = new Error(message);
    Object.assign(error, { code: 'PROJECT_CONVERSATION_AUTHORING_INVALID' });
    throw error;
}
export async function addConversationToProject(raw, projectAuthoring) {
    if (!projectAuthoring || typeof projectAuthoring.amend !== 'function') {
        fail('canonical project authoring amend dependency is required');
    }
    const request = normalizeProjectAddConversationRequest(raw);
    const result = await projectAuthoring.amend({
        project_ref: request.project_ref,
        expected_revision: request.expected_revision,
        amendment: request.amendment,
    });
    return Object.freeze({
        ...result,
        conversation_provenance: Object.freeze({
            schema: 'project-conversation-provenance-v1',
            text_length: request.conversation.text.length,
            citations: request.conversation.citations,
        }),
    });
}
