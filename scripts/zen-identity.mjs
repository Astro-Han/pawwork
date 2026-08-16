// Product plugin: wrap global fetch so OpenCode Zen requests look like the official CLI.
// DSH's llm-pi-ai overwrites User-Agent with deepseek-harness attribution, and
// llm/stream cannot change outbound headers. This is the smallest seam that can.

export const name = 'zen-identity';

export const OPENCODE_ZEN_HOST = 'opencode.ai';
export const OPENCODE_ZEN_HEADERS = Object.freeze({
  'user-agent': 'opencode/latest/1.16.2/cli',
  'x-opencode-client': 'cli',
});

export function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && typeof input.url === 'string') return input.url;
  return '';
}

export function isOpenCodeZenUrl(input) {
  try {
    const parsed = new URL(requestUrl(input));
    return parsed.hostname === OPENCODE_ZEN_HOST && parsed.pathname.startsWith('/zen');
  } catch {
    return false;
  }
}

export function applyOpenCodeZenHeaders(input, init) {
  const headers = new Headers(init?.headers ?? (input && typeof input === 'object' ? input.headers : undefined));
  headers.set('user-agent', OPENCODE_ZEN_HEADERS['user-agent']);
  headers.set('x-opencode-client', OPENCODE_ZEN_HEADERS['x-opencode-client']);
  return { ...(init || {}), headers };
}

export function wrapFetchForOpenCodeZen(fetchImpl) {
  return function fetchWithOpenCodeZenIdentity(input, init) {
    if (!isOpenCodeZenUrl(input)) return fetchImpl(input, init);
    return fetchImpl(input, applyOpenCodeZenHeaders(input, init));
  };
}

export function apply() {
  if (globalThis.fetch && globalThis.fetch.__pawworkZenIdentity) return;
  const original = globalThis.fetch;
  if (typeof original !== 'function') return;
  const wrapped = wrapFetchForOpenCodeZen(original.bind(globalThis));
  wrapped.__pawworkZenIdentity = true;
  globalThis.fetch = wrapped;
}
