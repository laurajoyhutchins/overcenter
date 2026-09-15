import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const broker = await readFile(new URL('../api/gcp-semantic-command-dispatch.js', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../.github/workflows/gcp-semantic-command.yml', import.meta.url), 'utf8');
const mcpAmend = await readFile(new URL('../mcp/project.amend.js', import.meta.url), 'utf8');
const amendRelay = await readFile(new URL('../lib/gcp-semantic-project-amend-relay.js', import.meta.url), 'utf8');
const workflowDispatch = await readFile(new URL('../lib/github-workflow-dispatch.js', import.meta.url), 'utf8');

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
  assert.match(workflow, /project\.amend\|github\.pull_request\.mark_ready\|github\.workflow\.dispatch\|github\.apply_changeset\|github\.coalesce_changeset\|github\.apply_text_replacements\)/);
});

test('project target is caller-selected and remains bounded away from bridge-source authority', () => {
  assert.doesNotMatch(broker, /const PROJECT_REF = 'github:laurajoyhutchins\/overcenter'/);
  assert.doesNotMatch(workflow, /test "\$PROJECT_REF" = 'github:laurajoyhutchins\/overcenter'/);
  assert.match(broker, /project_ref: request\.project_ref/);
  assert.match(workflow, /test "\$GITHUB_SHA" = "\$EXPECTED_HEAD"/);
  assert.match(workflow, /git ls-remote origin refs\/heads\/dev/);
  assert.doesNotMatch(workflow, /git ls-remote origin refs\/heads\/main/);
  assert.doesNotMatch(workflow, /group: overcenter-gcp-semantic-control-plane/);
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
  assert.match(workflow, /project\.amend\|github\.pull_request\.mark_ready\|github\.workflow\.dispatch\|github\.apply_changeset\|github\.coalesce_changeset\|github\.apply_text_replacements\)/);
});

test('workflow dispatch remains a bounded transport command instead of Hatchable orchestration', () => {
  assert.match(broker, /WORKFLOW_DISPATCH_COMMANDS = new Set\(\['github\.workflow\.dispatch'\]\)/);
  assert.match(broker, /GITHUB_WORKFLOW_DISPATCH_INPUT_FIELDS = new Set\(\['repo', 'workflow', 'ref', 'expected_head', 'inputs'\]\)/);
  assert.match(broker, /normalizeGitHubWorkflowDispatchInput/);
  assert.match(broker, /github\.workflow\.dispatch derives its target from input and does not accept project_ref/);
  assert.match(broker, /command_input_json: normalizeGitHubWorkflowDispatchInput\(body\.input\)/);
  assert.doesNotMatch(broker, /github\.workflow\.dispatch[\s\S]{0,200}projectTransitions|github\.workflow\.dispatch[\s\S]{0,200}lease/);
});

test('project.amend delegates through the generic ingress with host composition isolated at the MCP root', () => {
  assert.match(mcpAmend, /composeMcpRuntimeProviders/);
  assert.match(mcpAmend, /invokeAuthoritativeSemanticCommand/);
  assert.match(mcpAmend, /normalizeProjectAmendInput/);
  assert.match(mcpAmend, /githubAppAuth\.withApiClient/);
  assert.doesNotMatch(mcpAmend, /hatchable-runtime-providers/);
  assert.doesNotMatch(mcpAmend, /gcp-semantic-project-amend-relay/);
  assert.match(amendRelay, /invokeAuthoritativeSemanticCommand/);
  assert.doesNotMatch(amendRelay, /dispatchGitHubWorkflowWithGitHubApp/);
});

test('generic authoritative ingress preserves target revision independently from control-plane head', async () => {
  const { invokeAuthoritativeSemanticCommand } = await import('../lib/authoritative-semantic-command-ingress.js');
  const controlRevision = 'a'.repeat(40);
  const targetRevision = 'b'.repeat(40);
  let dispatchedInputs = null;
  const withGitHubAppApiClient = async (repo, callback) => {
    assert.equal(repo, 'laurajoyhutchins/overcenter');
    return callback({
      async call(service, request) {
        assert.equal(service, 'github');
        if (request.path.endsWith('/git/ref/heads/dev')) {
          return { status:200, body:{ object:{ sha:controlRevision } } };
        }
        if (request.path.endsWith('/dispatches')) {
          dispatchedInputs = request.body.inputs;
          return { status:204, body:null };
        }
        if (request.path.endsWith('/runs')) {
          return {
            status:200,
            body:{ workflow_runs:[{
              id:71,
              head_sha:controlRevision,
              event:'workflow_dispatch',
              display_title:`semantic ${dispatchedInputs.request_id}`,
              created_at:new Date().toISOString(),
              status:'queued',
            }] },
          };
        }
        throw new Error(`unexpected GitHub call ${request.method} ${request.path}`);
      },
    });
  };
  const projectRef = 'github:example/target';
  const result = await invokeAuthoritativeSemanticCommand({
    command:'project.amend',
    project_ref:projectRef,
    input:{ project_ref:projectRef, expected_revision:targetRevision, amendment:{ metadata:{ source:'test' } } },
  }, {
    withGitHubAppApiClient,
    readGitHubWorkflowSemanticReceipt: async ({ expected_head }) => ({
      outcome:'completed',
      response:{ outcome:'amended' },
      receipt:{ expected_head },
      mutation_certainty:'confirmed',
      may_have_mutated:true,
    }),
  });
  const encodedInput = Object.entries(dispatchedInputs)
    .filter(([key]) => key.startsWith('command_input_'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value)
    .join('');
  assert.equal(result.control_plane_revision, controlRevision);
  assert.equal(JSON.parse(encodedInput).expected_revision, targetRevision);
  assert.notEqual(result.control_plane_revision, JSON.parse(encodedInput).expected_revision);
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.response, { outcome:'amended' });
  assert.ok(result.receipt);
});

test('project.amend response recording preserves authoritative invocation identity in run-local evidence', () => {
  assert.match(workflow, /response_sha256/);
  assert.match(workflow, /response_b64/);
  assert.match(workflow, /bounded-semantic-response\.json/);
  assert.match(workflowDispatch, /readGitHubWorkflowSemanticReceipt/);
  assert.match(workflowDispatch, /responseEncoding:'base64'/);
  assert.match(workflowDispatch, /GITHUB_WORKFLOW_RECEIPT_DIGEST_MISMATCH/);
  assert.match(workflow, /request_id:\$request_id/);
  assert.match(workflow, /command:\$command/);
  assert.match(workflow, /expected_head:\$expected_head/);
  assert.match(workflow, /response:\$response/);
});
