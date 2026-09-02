import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const classificationUrl = new URL('../../../.contract-evidence/classifications.json', import.meta.url);

async function classifications() {
  return JSON.parse(await readFile(classificationUrl, 'utf8')).candidates;
}

const EXPECTED = Object.freeze({
  'typescript:src/semantic/execution-authority-contracts.ts#ExecutionAuthorityLocator': { logical_contract:'execution.authority.locator', significance:'authority' },
  'typescript:src/semantic/execution-authority-contracts.ts#ProjectTransitionExecutionAuthority': { logical_contract:'execution.authority.project-transition', significance:'authority' },
  'typescript:src/semantic/project-graph-reconciliation.ts#ProjectGraphAuthorityCoordinate': { logical_contract:'project.graph.authority-coordinate', significance:'authority' },
  'typescript:src/semantic/execution-lifecycle-contracts.ts#PRODUCTIVE_STAGES': { logical_contract:'execution.lifecycle.productive-stages', significance:'authority', semver_kind:'lifecycle-semantics' },
  'typescript:src/semantic/execution-lifecycle-contracts.ts#OPERATING_CONDITIONS': { logical_contract:'execution.lifecycle.operating-conditions', significance:'authority', semver_kind:'lifecycle-semantics' },
  'typescript:src/semantic/execution-lifecycle-contracts.ts#WORK_SETTLEMENT_DISPOSITIONS': { logical_contract:'execution.lifecycle.work-settlement-dispositions', significance:'authority', semver_kind:'lifecycle-semantics' },
  'typescript:src/semantic/project-transition-status-contracts.ts#PROJECT_TRANSITION_STATES': { logical_contract:'project.transition.states', significance:'authority', semver_kind:'lifecycle-semantics' },
  'typescript:src/semantic/execution-authority-contracts.ts#StoredExecutionRun': { logical_contract:'execution.store.run', significance:'durable-internal' },
  'typescript:src/semantic/execution-authority-contracts.ts#StoredExecutionLease': { logical_contract:'execution.store.lease', significance:'durable-internal' },
  'typescript:src/semantic/execution-authority-contracts.ts#StoredExecutionSlot': { logical_contract:'execution.store.slot', significance:'durable-internal' },
  'typescript:src/semantic/execution-authority-contracts.ts#ExecutionAuthorityStore': { logical_contract:'execution.authority.store-port', significance:'boundary-internal' },
  'typescript:src/ports/project-advance-runtime-host.ts#ProjectAdvanceRuntimeHost': { logical_contract:'project.advance.runtime-host', significance:'boundary-internal' },
  'typescript:src/semantic/execution-evidence-contracts.ts#ExecutionEvidence': { logical_contract:'execution.evidence', significance:'public', semver_kind:'public-evidence-schema' },
  'typescript:src/semantic/execution-evidence.ts#executionEvidenceInternals': { logical_contract:'execution.evidence.internals', significance:'implementation-only' },
  'mcp:mcp/production.promote.js#inputSchema': { significance:'projection', projection_of:'production.promote.input' },
  'mcp:mcp/project.advance.js#inputSchema': { significance:'projection', projection_of:'project.advance.input' },
  'mcp:mcp/project.amend.js#inputSchema': { significance:'projection', projection_of:'project.amend.input' },
  'mcp:mcp/project.define.js#inputSchema': { significance:'projection', projection_of:'project.define.input' },
  'mcp:mcp/project.inspect.js#inputSchema': { significance:'projection', projection_of:'project.inspect.input' },
  'mcp:mcp/release.publish.js#inputSchema': { significance:'projection', projection_of:'release.publish.input' },
});

test('kernel contract authorities and transport projections are explicitly classified', async () => {
  const actual = await classifications();
  for (const [sourceIdentity, expected] of Object.entries(EXPECTED)) {
    for (const [field, value] of Object.entries(expected)) {
      assert.deepEqual(actual[sourceIdentity]?.[field], value, `${sourceIdentity}.${field}`);
    }
  }
});
