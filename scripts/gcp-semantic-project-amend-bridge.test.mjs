import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const broker = await readFile(new URL('../api/gcp-semantic-command-dispatch.js', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../.github/workflows/gcp-semantic-command.yml', import.meta.url), 'utf8');

test('bounded GCP bridge admits project.amend without conflating control-plane head and target revision', () => {
  assert.match(broker, /PROJECT_AUTHORING_COMMANDS = new Set\(\['project\.amend'\]\)/);
  assert.match(broker, /PROJECT_REF = \/\^github:/);
  assert.match(broker, /ALLOWED_FIELDS = new Set\(\[[^\]]*'project_ref'/);
  assert.match(broker, /normalizeProjectAmendInput\(value, projectRef\)/);
  assert.match(broker, /input\.project_ref/);
  assert.match(broker, /input\.expected_revision/);
  assert.doesNotMatch(broker, /expectedRevision !== expectedHead/);
  assert.match(broker, /inputProjectRef !== projectRef/);
  assert.match(broker, /expected_revision: expectedRevision/);
  assert.match(broker, /project authoring commands do not accept project\.advance continuation fields/);

  assert.match(workflow, /- project\.amend/);
  assert.match(workflow, /project\.amend\)/);
  assert.match(workflow, /\^github:\[A-Za-z0-9_\.-\]\+\/\[A-Za-z0-9_\.-\]\+\$/);
  assert.match(workflow, /\.project_ref == \$project_ref/);
  assert.match(workflow, /\.expected_revision \| type == "string" and test\("\^\[0-9a-f\]\{40\}\$"\)/);
  assert.doesNotMatch(workflow, /\.expected_revision == \$expected_revision/);
  assert.match(workflow, /project\.amend\|github\.pull_request\.mark_ready\|github\.apply_changeset\|github\.apply_text_replacements\)/);
});

test('project target is caller-selected and remains bounded away from bridge-source authority', () => {
  assert.doesNotMatch(broker, /const PROJECT_REF = 'github:laurajoyhutchins\/overcenter'/);
  assert.doesNotMatch(workflow, /test "\$PROJECT_REF" = 'github:laurajoyhutchins\/overcenter'/);
  assert.match(broker, /project_ref: request\.project_ref/);
  assert.match(workflow, /test "\$GITHUB_SHA" = "\$EXPECTED_HEAD"/);
  assert.match(workflow, /git ls-remote origin refs\/heads\/dev/);
  assert.match(workflow, /git ls-remote origin refs\/heads\/main/);
  assert.match(workflow, /group: overcenter-gcp-semantic-control-plane/);
});

test('project.amend remains bounded away from advance and lease authority', () => {
  assert.doesNotMatch(broker, /PROJECT_COMMANDS = new Set\(\[[^\]]*project\.amend/);
  assert.doesNotMatch(broker, /LEASE_MUTATION_COMMANDS = new Set\(\[[^\]]*project\.amend/);
  assert.match(workflow, /project\.amend\)[\s\S]*test -z "\$TRANSITION_ID"[\s\S]*test -z "\$RESUME_REF"[\s\S]*test -z "\$EXECUTION_RESULT_JSON"/);
});

test('PR integration is brokered through GCP instead of thawing Hatchable GitHub mutation authority', () => {
  assert.match(broker, /GITHUB_INTEGRATION_COMMANDS = new Set\(\['github\.pull_request\.mark_ready'\]\)/);
  assert.match(broker, /normalizeGitHubIntegrationInput/);
  assert.match(workflow, /- github\.pull_request\.mark_ready/);
  assert.match(workflow, /github\.pull_request\.mark_ready\)/);
  assert.match(workflow, /\.repo \| type == "string"/);
  assert.ok(workflow.includes('test("^[A-Za-z0-9_.-]+\\\\/[A-Za-z0-9_.-]+$")'));
  assert.match(workflow, /\.pull_request \| type == "number"/);
  assert.match(workflow, /\.expected_head \| type == "string" and test\("\^\[0-9a-f\]\{40\}\$"\)/);
  assert.match(workflow, /project\.amend\|github\.pull_request\.mark_ready\|github\.apply_changeset\|github\.apply_text_replacements\)/);
});
