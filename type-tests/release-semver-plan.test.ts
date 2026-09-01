import {
  bumpStableSemver,
  deriveReleaseSemverPlan,
  type ReleaseSemverPlan,
} from '../src/semantic/release-semver-plan.js';

const patch: string = bumpStableSemver('1.2.3', 'patch');
const minor: string = bumpStableSemver('1.2.3', 'minor');
const major: string = bumpStableSemver('1.2.3', 'major');
const preOneBreaking: string = bumpStableSemver('0.8.4', 'major');
void patch;
void minor;
void major;
void preOneBreaking;

const planPromise: Promise<ReleaseSemverPlan> = deriveReleaseSemverPlan({
  project_ref:'github:example/project',
  authority:{ kind:'github', repository:'example/project', revision:'a'.repeat(40), derivation:'overcenter-project-graph-v1' },
  horizon:{
    schema:'project-horizon-v1',
    kind:'release',
    ref:'next',
    authority:{ kind:'github', repository:'example/project', revision:'a'.repeat(40), derivation:'overcenter-project-graph-v1' },
    authority_key:`github:example/project@${'a'.repeat(40)}#overcenter-project-graph-v1`,
    target_node_ids:['feature'],
    scope_node_ids:['foundation','feature'],
  },
  base_release:{ version:'0.1.0', included_transition_ids:['foundation'] },
  transitions:[
    { id:'foundation', version_impact:{ level:'major', summary:'Historical breaking change.' } },
    { id:'feature', version_impact:{ level:'minor', summary:'Add feature.' } },
  ],
});
void planPromise;

// @ts-expect-error impact must be one of the semantic version impact levels
bumpStableSemver('1.2.3', 'feature');
