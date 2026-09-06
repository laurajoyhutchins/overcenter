import { canonicalProjectDefinition } from './project-authoring.js';
import type { CanonicalProjectDefinition } from './project-authoring.js';

const SHA40 = /^[0-9a-f]{40}$/;

export type ProjectDefineRequest = Readonly<{
  project_ref: string;
  expected_revision: string;
  definition: CanonicalProjectDefinition;
}>;

export type ProjectAmendRequest = Readonly<{
  project_ref: string;
  expected_revision: string;
  amendment: Readonly<Record<string, unknown>>;
}>;

export type ProjectConversationCitation = Readonly<{
  kind: string;
  ref: string;
}>;

export type ProjectConversation = Readonly<{
  text: string;
  citations: readonly ProjectConversationCitation[];
}>;

export type ProjectAddConversationRequest = Readonly<{
  project_ref: string;
  expected_revision: string;
  conversation: ProjectConversation;
  amendment: Readonly<Record<string, unknown>>;
}>;

function fail(message: string, details: unknown = null): never {
  const error = new Error(message);
  Object.assign(error, { code:'PROJECT_AUTHORING_COMMAND_INVALID', details });
  throw error;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`, { field });
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail(`${field} must be a non-empty string`, { field });
  return normalized;
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length) fail(`${field} contains unsupported field${unknown.length === 1 ? '' : 's'}`, { field, unknown });
}

function revision(value: unknown): string {
  const normalized = text(value, 'expected_revision').toLowerCase();
  if (!SHA40.test(normalized)) fail('expected_revision must be an exact 40-character Git revision', { expected_revision:normalized });
  return normalized;
}

function projectRef(value: unknown): string {
  const normalized = text(value, 'project_ref');
  if (!/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    fail('project_ref must be an exact github:owner/repo authority coordinate', { project_ref:normalized });
  }
  return normalized;
}

function conversation(value: unknown): ProjectConversation {
  const input = record(value, 'conversation');
  exactKeys(input, ['text','citations'], 'conversation');
  const conversationText = text(input.text, 'conversation.text');
  if (conversationText.length > 125000) fail('conversation.text exceeds the bounded semantic-command limit', { max_length:125000 });
  const citationsInput = input.citations == null ? [] : input.citations;
  if (!Array.isArray(citationsInput)) fail('conversation.citations must be an array', { field:'conversation.citations' });
  if (citationsInput.length > 128) fail('conversation.citations exceeds the bounded semantic-command limit', { max_items:128 });
  const citations = citationsInput.map((citationInput, index) => {
    const citation = record(citationInput, `conversation.citations[${index}]`);
    exactKeys(citation, ['kind','ref'], `conversation.citations[${index}]`);
    return Object.freeze({
      kind:text(citation.kind, `conversation.citations[${index}].kind`),
      ref:text(citation.ref, `conversation.citations[${index}].ref`),
    });
  });
  return Object.freeze({ text:conversationText, citations:Object.freeze(citations) });
}

export function normalizeProjectDefineRequest(raw: unknown): ProjectDefineRequest {
  const input = record(raw, 'project.define request');
  exactKeys(input, ['project_ref','expected_revision','definition'], 'project.define request');
  const normalizedProjectRef = projectRef(input.project_ref);
  const definition = canonicalProjectDefinition(input.definition);
  if (definition.project_ref !== normalizedProjectRef) {
    fail('definition.project_ref must match project_ref', { project_ref:normalizedProjectRef, definition_project_ref:definition.project_ref });
  }
  return Object.freeze({
    project_ref:normalizedProjectRef,
    expected_revision:revision(input.expected_revision),
    definition,
  });
}

export function normalizeProjectAmendRequest(raw: unknown): ProjectAmendRequest {
  const input = record(raw, 'project.amend request');
  exactKeys(input, ['project_ref','expected_revision','amendment'], 'project.amend request');
  const amendment = record(input.amendment, 'amendment');
  return Object.freeze({
    project_ref:projectRef(input.project_ref),
    expected_revision:revision(input.expected_revision),
    amendment:Object.freeze({ ...amendment }),
  });
}

export function normalizeProjectAddConversationRequest(raw: unknown): ProjectAddConversationRequest {
  const input = record(raw, 'project.add_conversation request');
  exactKeys(input, ['project_ref','expected_revision','conversation','amendment'], 'project.add_conversation request');
  if (!Object.prototype.hasOwnProperty.call(input, 'amendment')) fail('amendment is required because the reasoning layer, not the graph kernel, decides conversation semantics');
  const amendment = record(input.amendment, 'amendment');
  return Object.freeze({
    project_ref:projectRef(input.project_ref),
    expected_revision:revision(input.expected_revision),
    conversation:conversation(input.conversation),
    amendment:Object.freeze({ ...amendment }),
  });
}
