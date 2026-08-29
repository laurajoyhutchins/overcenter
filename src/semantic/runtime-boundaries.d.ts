declare module 'lib/canonical-json.js' {
  export function canonicalJson(value: unknown): string;
  export function sha256Text(value: string): Promise<string>;
}

declare module 'lib/work-identity.js' {
  export function repositoryIdentity(value: unknown): string | null;
}
