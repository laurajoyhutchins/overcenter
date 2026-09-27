export interface GitHubActionsWorkflowScanFact {
  kind: 'github-actions-workflow-scan';
  source_revision: string;
  workflow_paths: string[];
}

export interface GitHubActionsExplicitWriteCapabilityFact {
  kind: 'github-actions-explicit-write-capability';
  source_revision: string;
  workflow_path: string;
  permission: string;
}

export interface GitHubActionsInheritedPermissionsFact {
  kind: 'github-actions-inherited-permissions';
  source_revision: string;
  workflow_path: string;
}

export type GitHubActionsObservedFact =
  | GitHubActionsWorkflowScanFact
  | GitHubActionsExplicitWriteCapabilityFact
  | GitHubActionsInheritedPermissionsFact;

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

function withoutComment(line: string): string {
  const index = line.indexOf('#');
  return index === -1 ? line : line.slice(0, index);
}

function inlineWritePermissions(value: string): string[] {
  const permissions: string[] = [];
  const matches = value.matchAll(/([a-z][a-z0-9-]*)\s*:\s*write\b/g);
  for (const match of matches) permissions.push(match[1]!);
  return permissions;
}

export function explicitGitHubActionsWritePermissions(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const permissions = new Set<string>();
  let blockIndent: number | null = null;

  for (const rawLine of lines) {
    const line = withoutComment(rawLine);
    const trimmed = line.trim();
    if (!trimmed) continue;

    const indent = indentation(line);
    if (blockIndent !== null) {
      if (indent <= blockIndent) {
        blockIndent = null;
      } else {
        const permission = trimmed.match(/^([a-z][a-z0-9-]*):\s*write\s*$/)?.[1];
        if (permission) permissions.add(permission);
        continue;
      }
    }

    const permissionsDeclaration = trimmed.match(/^permissions:\s*(.*)$/);
    if (!permissionsDeclaration) continue;
    const value = permissionsDeclaration[1]!.trim();
    if (!value) {
      blockIndent = indent;
      continue;
    }
    if (value === 'write-all') {
      permissions.add('*');
      continue;
    }
    for (const permission of inlineWritePermissions(value)) permissions.add(permission);
  }

  return [...permissions].sort();
}

export function hasExplicitRootPermissions(source: string): boolean {
  return source
    .split(/\r?\n/)
    .some((line) => /^permissions:\s*/.test(withoutComment(line).trimEnd()));
}

export function observeGitHubActionsSources(
  sources: Readonly<Record<string, string>>,
  sourceRevision: string,
): GitHubActionsObservedFact[] {
  if (!sourceRevision) throw new Error('ARCHITECTURE_SOURCE_REVISION_INVALID');
  const workflowPaths = Object.keys(sources).sort();
  const facts: GitHubActionsObservedFact[] = [
    {
      kind: 'github-actions-workflow-scan',
      source_revision: sourceRevision,
      workflow_paths: workflowPaths,
    },
  ];

  for (const workflowPath of workflowPaths) {
    const source = sources[workflowPath]!;
    for (const permission of explicitGitHubActionsWritePermissions(source)) {
      facts.push({
        kind: 'github-actions-explicit-write-capability',
        source_revision: sourceRevision,
        workflow_path: workflowPath,
        permission,
      });
    }
    if (!hasExplicitRootPermissions(source)) {
      facts.push({
        kind: 'github-actions-inherited-permissions',
        source_revision: sourceRevision,
        workflow_path: workflowPath,
      });
    }
  }

  return facts;
}
