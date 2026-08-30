export type ProjectTransitionDependencyDefinition = Readonly<{
  transition_id: string;
  requires: readonly string[];
}>;

function requireText(value: string, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new TypeError(`${field} must be a non-empty string`);
  return normalized;
}

export async function projectTransitionDependencyFingerprint(
  definition: ProjectTransitionDependencyDefinition,
): Promise<string> {
  const transitionId = requireText(definition.transition_id, 'transition_id');
  if (!Array.isArray(definition.requires)) throw new TypeError('requires must be an array');
  const requires = definition.requires.map((value, index) => requireText(value, `requires[${index}]`));
  const unique = [...new Set(requires)].sort();
  if (unique.length !== requires.length) throw new TypeError('requires must not contain duplicates');
  const payload = JSON.stringify({ schema: 'project-transition-dependencies-v1', transition_id: transitionId, requires: unique });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}