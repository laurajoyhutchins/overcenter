export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('lib/')) {
    return { url: new URL(`../${specifier}`, import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}