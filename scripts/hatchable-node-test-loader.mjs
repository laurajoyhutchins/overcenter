import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hatchableStub = `
export const api = {};
export const config = {};
export const db = { async query() { return { rows: [] }; } };
export const storage = {};
`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'hatchable') {
    return {
      url:`data:text/javascript,${encodeURIComponent(hatchableStub)}`,
      shortCircuit:true,
    };
  }
  if (specifier.startsWith('lib/')) {
    return {
      url:pathToFileURL(path.resolve(process.cwd(), specifier)).href,
      shortCircuit:true,
    };
  }
  return nextResolve(specifier, context);
}