import { registerHooks } from 'node:module';

const hostModuleSource = String.raw`
const failure = (service, method) => {
  const error = new Error(
    'Hatchable host binding ' + service + '.' + method + ' is unavailable in the portable Node test runtime. Inject the dependency explicitly.',
  );
  error.code = 'HATCHABLE_HOST_BINDING_REQUIRED';
  throw error;
};

const unavailable = (service) => new Proxy(Object.create(null), {
  get(_target, property) {
    if (property === Symbol.toStringTag) return 'HatchableHostUnavailable';
    return (..._args) => failure(service, String(property));
  },
});

export const api = unavailable('api');
export const db = unavailable('db');
export const config = unavailable('config');
export const storage = unavailable('storage');
export const auth = unavailable('auth');
export const email = unavailable('email');
export const ai = unavailable('ai');
export const agent = unavailable('agent');
export const cache = unavailable('cache');
export const knowledge = unavailable('knowledge');
export const memory = unavailable('memory');
export const tasks = unavailable('tasks');
export const scheduler = unavailable('scheduler');
export const browser = unavailable('browser');
export const run = unavailable('run');
export const approval = unavailable('approval');
`;

const hostModuleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(hostModuleSource)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'hatchable') {
      return { url: hostModuleUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});