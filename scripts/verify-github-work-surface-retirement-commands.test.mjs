import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';
import { closeGithubPullRequestWithApi, closeGithubIssueWithApi } from '../lib/github-work-surface-close.js';

test('GitHub work-surface retirement is exposed only as narrow typed provider-effect commands', () => {
  const pr = semanticCommandDescriptor('github.pull_request.close');
  assert.deepEqual(pr.semantic_fields, ['repo', 'pull_request', 'expected_head', 'artifact_ref', 'run_id']);
  assert.deepEqual(pr.required_fields, ['repo', 'pull_request', 'expected_head', 'artifact_ref']);
  assert.deepEqual(pr.exposure, { worker:true, mcp:false });

  const issue = semanticCommandDescriptor('github.issue.close');
  assert.deepEqual(issue.semantic_fields, ['repo', 'issue', 'artifact_ref', 'run_id']);
  assert.deepEqual(issue.required_fields, ['repo', 'issue', 'artifact_ref']);
  assert.deepEqual(issue.exposure, { worker:true, mcp:false });
});

test('retirement commands are idempotent and distinguish issue objects from pull requests', async () => {
  const closedPrApi={calls:0,async call(){this.calls+=1;return {status:200,headers:{},body:{number:7,state:'closed',merged:false,head:{sha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},html_url:'https://github.com/o/r/pull/7'}};}};
  const pr=await closeGithubPullRequestWithApi({repo:'o/r',pull_request:7,expected_head:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',artifact_ref:'artifact:pr:7'},{apiClient:closedPrApi});
  assert.equal(pr.ok,true); assert.equal(pr.outcome,'already_closed'); assert.equal(pr.mutation_attempted,false); assert.equal(closedPrApi.calls,1);
  const issueApi={calls:0,async call(){this.calls+=1;return {status:200,headers:{},body:{number:8,state:'open',pull_request:{url:'x'},html_url:'https://github.com/o/r/pull/8'}};}};
  const issue=await closeGithubIssueWithApi({repo:'o/r',issue:8,artifact_ref:'artifact:issue:8'},{apiClient:issueApi});
  assert.equal(issue.ok,false); assert.equal(issue.error,'GITHUB_PROVIDER_IDENTITY_MISMATCH'); assert.equal(issueApi.calls,1);
});

test('uncertain pull-request close reconciles only when exact head is still proven closed', async () => {
  let step=0; const api={async call(){step+=1;if(step===1)return {status:200,headers:{},body:{number:9,state:'open',merged:false,head:{sha:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}}};if(step===2)throw new Error('socket vanished after write');return {status:200,headers:{},body:{number:9,state:'closed',merged:false,head:{sha:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}}};}};
  const result=await closeGithubPullRequestWithApi({repo:'o/r',pull_request:9,expected_head:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',artifact_ref:'artifact:pr:9'},{apiClient:api,maxAttempts:1});
  assert.equal(result.ok,true); assert.equal(result.reconciled_after_indeterminate,true); assert.equal(result.artifact_ref,'artifact:pr:9');
});