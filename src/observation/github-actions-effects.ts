import { createHash } from 'node:crypto';

export type GitHubActionsProviderEffect =
  | 'github-git-blob/create'
  | 'github-git-tree/create'
  | 'github-git-commit/create'
  | 'github-git-ref/create'
  | 'github-git-ref/update'
  | 'github-git-ref/delete'
  | 'github-pull-request/create'
  | 'github-commit-status/create';

export interface GitHubActionsProviderEffectInvocationFact {
  kind: 'github-actions-provider-effect-invocation';
  source_revision: string;
  workflow_path: string;
  effect: GitHubActionsProviderEffect;
  line_number: number;
  statement_sha256: string;
}

export interface RecognizedGitHubActionsProviderEffect {
  effect: GitHubActionsProviderEffect;
  line_number: number;
  statement_sha256: string;
}

function digestStatement(statement: string): string {
  return createHash('sha256').update(statement.trim()).digest('hex');
}

function endpointEffect(endpoint: string): GitHubActionsProviderEffect | null {
  if (/\/statuses\/[^/"'\s]+(?:["'\s]|$)/.test(endpoint)) {
    return 'github-commit-status/create';
  }
  if (/\/pulls(?:["'\s]|$)/.test(endpoint) && !/\/pulls\//.test(endpoint)) {
    return 'github-pull-request/create';
  }
  if (/\/git\/blobs(?:["'\s]|$)/.test(endpoint)) return 'github-git-blob/create';
  if (/\/git\/trees(?:["'\s]|$)/.test(endpoint)) return 'github-git-tree/create';
  if (/\/git\/commits(?:["'\s]|$)/.test(endpoint)) return 'github-git-commit/create';
  if (/\/git\/refs(?:["'\s]|$)/.test(endpoint)) return 'github-git-ref/create';
  return null;
}

function gitPushEffect(line: string): GitHubActionsProviderEffect {
  const refspec = line.match(/\bgit\s+push\b[^\n]*\borigin\b\s+["']?([^"'\s]+)/)?.[1] ?? '';
  return refspec.startsWith(':') ? 'github-git-ref/delete' : 'github-git-ref/update';
}

function isPostCurl(lines: string[], index: number): boolean {
  const start = Math.max(0, index - 10);
  const window = lines.slice(start, index + 1).join('\n');
  return /(?:--request\s+POST|-X\s+POST)\b/.test(window);
}

export function recognizedGitHubActionsProviderEffects(
  source: string,
): RecognizedGitHubActionsProviderEffect[] {
  const lines = source.split(/\r?\n/);
  const effects: RecognizedGitHubActionsProviderEffect[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    let effect: GitHubActionsProviderEffect | null = null;

    if (/\bgit\s+push\b/.test(line)) {
      effect = gitPushEffect(line);
    } else {
      const apiPostEndpoint = line.match(/\bapi_post\s+["']([^"']+)["']/)?.[1];
      if (apiPostEndpoint) {
        effect = endpointEffect(apiPostEndpoint);
      } else if (/api\.github\.com\/repos\//.test(line) && isPostCurl(lines, index)) {
        effect = endpointEffect(line);
      }
    }

    if (!effect) continue;
    effects.push({
      effect,
      line_number: index + 1,
      statement_sha256: digestStatement(line),
    });
  }

  return effects;
}

export function observeGitHubActionsProviderEffects(
  sources: Readonly<Record<string, string>>,
  sourceRevision: string,
): GitHubActionsProviderEffectInvocationFact[] {
  if (!sourceRevision) throw new Error('ARCHITECTURE_SOURCE_REVISION_INVALID');

  const facts: GitHubActionsProviderEffectInvocationFact[] = [];
  for (const workflowPath of Object.keys(sources).sort()) {
    for (const observed of recognizedGitHubActionsProviderEffects(sources[workflowPath]!)) {
      facts.push({
        kind: 'github-actions-provider-effect-invocation',
        source_revision: sourceRevision,
        workflow_path: workflowPath,
        ...observed,
      });
    }
  }
  return facts;
}
