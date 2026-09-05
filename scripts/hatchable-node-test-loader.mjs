const HATCHABLE_TEST_URL = 'overcenter-hatchable:test';
const projectRoot = new URL('../', import.meta.url);

const hatchableStub = `
function unavailable(capability) {
  const error = new Error(\`Hatchable SDK capability \\"\${capability}\\" is unavailable in raw Node tests; inject an explicit test dependency instead.\`);
  error.code = 'HATCHABLE_SDK_UNAVAILABLE_IN_NODE_TEST';
  throw error;
}
function blocked(name) {
  return new Proxy(function blockedHatchableCapability() { return unavailable(name); }, {
    get(_target, property) {
      if (property === 'then') return undefined;
      return unavailable(\`\${name}.\${String(property)}\`);
    },
    apply() { return unavailable(name); },
  });
}
export const api = blocked('api');
export const db = blocked('db');
export const config = blocked('config');
`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'hatchable') {
    return { url:HATCHABLE_TEST_URL, shortCircuit:true };
  }
  if (specifier.startsWith('lib/')) {
    return { url:new URL(`../${specifier}`, import.meta.url).href, shortCircuit:true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === HATCHABLE_TEST_URL) {
    return { format:'module', source:hatchableStub, shortCircuit:true };
  }
  return nextLoad(url, context);
}