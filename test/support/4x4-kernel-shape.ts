export const FOUR_BY_FOUR_NOUNS = ['Object', 'Event', 'Proposition', 'Coordinate'] as const;
export const FOUR_BY_FOUR_VERBS = ['permits', 'asserts', 'supports', 'requires'] as const;

export const FOUR_BY_FOUR_STRUCTURAL_TYPES = [
  'FourByFourSourceKind',
  'FourByFourSource',
  'FourByFourProjection',
] as const;

const FOUR_BY_FOUR_PRIMITIVE_TYPES = [
  ...FOUR_BY_FOUR_NOUNS.map((name) => `FourByFour${name}`),
  ...FOUR_BY_FOUR_VERBS.map((name) => `FourByFour${name[0]!.toUpperCase()}${name.slice(1)}`),
];

const FOUR_BY_FOUR_PROJECTION_FIELDS = [
  'objects',
  'events',
  'propositions',
  'coordinates',
  ...FOUR_BY_FOUR_VERBS,
] as const;

export function assertSemanticKernelProjectionSource(source: string): void {
  const declarations = [
    ...source.matchAll(/\b(?:export\s+)?(?:interface|type)\s+(FourByFour[A-Za-z0-9_]+)/g),
  ].map((match) => match[1]!);
  const allowed = new Set<string>([
    ...FOUR_BY_FOUR_PRIMITIVE_TYPES,
    ...FOUR_BY_FOUR_STRUCTURAL_TYPES,
  ]);

  for (const declaration of declarations) {
    if (!allowed.has(declaration)) {
      throw new Error(`FOUR_BY_FOUR_KERNEL_PRIMITIVE_DRIFT:${declaration}`);
    }
  }
  for (const declaration of allowed) {
    if (!declarations.includes(declaration)) {
      throw new Error(`FOUR_BY_FOUR_KERNEL_DECLARATION_MISSING:${declaration}`);
    }
  }

  const projection = source.match(/export interface FourByFourProjection\s*\{([\s\S]*?)\n\}/);
  if (!projection) throw new Error('FOUR_BY_FOUR_KERNEL_PROJECTION_MISSING');
  const fields = [...projection[1]!.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*):/gm)].map(
    (match) => match[1]!,
  );
  if (JSON.stringify(fields) !== JSON.stringify(FOUR_BY_FOUR_PROJECTION_FIELDS)) {
    throw new Error(`FOUR_BY_FOUR_KERNEL_PROJECTION_DRIFT:${fields.join(',')}`);
  }
}
