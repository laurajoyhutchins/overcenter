import {
  PROJECT_VERSION_IMPACT_LEVELS,
  normalizeProjectVersionImpact,
  type ProjectVersionImpact,
  type ProjectVersionImpactLevel,
} from '../src/semantic/project-version-impact.js';

type Fail = (code: string, message: string, details?: unknown) => never;
declare const fail: Fail;

const impact: ProjectVersionImpact | null = normalizeProjectVersionImpact(
  { level:'minor', summary:'Add an externally visible semantic command.' },
  'transition-a',
  fail,
);
void impact;

const level: ProjectVersionImpactLevel = PROJECT_VERSION_IMPACT_LEVELS[2];
void level;

// @ts-expect-error arbitrary release labels are not valid semantic impact levels
const invalidLevel: ProjectVersionImpactLevel = 'feature';
void invalidLevel;

// @ts-expect-error canonical level list is immutable
PROJECT_VERSION_IMPACT_LEVELS.push('patch');
