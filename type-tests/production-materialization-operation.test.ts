import {
  materializeProduction,
  type ProductionMaterializationFailure,
  type ProductionMaterializationPorts,
} from '../src/semantic/production-materialization-operation';

const sourceFiles = Object.freeze([
  Object.freeze({ path:'lib/example.js', content:'export const example = true;\n' }),
]);

const runtimeFiles = Object.freeze([
  Object.freeze({ path:'lib/stale.js', hash:'0'.repeat(64), size:1 }),
]);

const calls: string[] = [];
const ports: ProductionMaterializationPorts = {
  resolveProductionSource: async (repo) => {
    calls.push(`resolve:${repo}`);
    return { repository:repo, branch:'main', revision:'a'.repeat(40) };
  },
  observeSource: async (coordinate) => {
    calls.push(`source:${coordinate.revision}`);
    return { ...coordinate, files:sourceFiles };
  },
  observeRuntime: async (repo) => {
    calls.push(`runtime:${repo}`);
    return { runtime_ref:'runtime:production', version:41, files:runtimeFiles };
  },
  stageRuntime: async (request) => {
    calls.push(`stage:${request.runtime_ref}:${request.expected_version}`);
  },
  inspectRuntimeDraft: async (runtimeRef) => {
    calls.push(`draft:${runtimeRef}`);
    return { runtime_ref:runtimeRef, version:41, files:[] };
  },
  deployRuntime: async (request) => {
    calls.push(`deploy:${request.runtime_ref}:${request.expected_version}`);
    return { runtime_ref:request.runtime_ref, version:42 };
  },
  inspectImmutableDeployment: async (request) => {
    calls.push(`immutable:${request.runtime_ref}:${request.version}`);
    return { runtime_ref:request.runtime_ref, version:request.version, files:[] };
  },
  verifyProduction: async (request) => {
    calls.push(`verify:${request.runtime_ref}:${request.version}`);
    return { ok:true, verification_ref:'runtime-proof:42' };
  },
};

const result = await materializeProduction({ repo:'laurajoyhutchins/overcenter' }, ports);
const resultRepository: string = result.repository;
const resultRevision: string = result.revision;
const resultRuntimeRef: string = result.runtime_ref;
const resultVersion: number = result.deployment_version;
const resultVerificationRef: string = result.verification_ref;
void resultRepository;
void resultRevision;
void resultRuntimeRef;
void resultVersion;
void resultVerificationRef;
void calls;

let observedFailure: ProductionMaterializationFailure | null = null;
try {
  await materializeProduction({ repo:'laurajoyhutchins/overcenter' }, {
    ...ports,
    stageRuntime: async () => {
      throw new Error('connection lost after staging began');
    },
  });
} catch (error) {
  observedFailure = error as ProductionMaterializationFailure;
}
if (!observedFailure) throw new Error('expected mutation-indeterminate materialization failure');
const postEffectMutation: true = observedFailure.may_have_mutated;
void postEffectMutation;
