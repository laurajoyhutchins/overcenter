function normalize(value:unknown):unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalize);
  const source = value as Record<string, unknown>;
  const result:Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) result[key] = normalize(source[key]);
  }
  return result;
}

export function canonicalJson(value:unknown):string {
  return JSON.stringify(normalize(value));
}

export async function sha256Text(text:string):Promise<string> {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
