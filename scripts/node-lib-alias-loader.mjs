export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'hatchable') return { url: 'data:text/javascript,export const api={};export const db={};export const config={};', shortCircuit: true };
  if (specifier.startsWith('lib/')) return { url: new URL(`../${specifier}`, import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}