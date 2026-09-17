// Process preload: wrap global fetch so OpenCode Zen requests look like the official client.
// DSH's llm-pi-ai overwrites User-Agent with deepseek-harness attribution, and
// llm/stream cannot change outbound headers. Loaded with Node --import before dsh.
import { createHash } from 'node:crypto';

// The identity the official client sends: its server builds
// `opencode/<channel>/<version>/<client>`, a release build's channel is `latest`,
// and PawWork is a desktop app, which is the client the opencode desktop sets too.
// Track the version against the current @opencode-ai/desktop release.
export const OPENCODE_ZEN_HOST = 'opencode.ai';
export const OPENCODE_ZEN_HEADERS = Object.freeze({
  'user-agent': 'opencode/latest/1.18.15/desktop',
  'x-opencode-client': 'desktop',
});

// The gateway groups a conversation's requests by `x-opencode-session` and
// rejects inference requests that omit it. It also reads the value: since
// 2026-09-17 it serves the free tier only to ids shaped like the ones its own
// client mints — `ses_`, twelve hex characters, fourteen more alphanumerics —
// and answers anything else with FreeTierError. pi-ai already writes the harness
// session id, stable for the life of a conversation, as `x-client-request-id`,
// so it is reshaped into that form rather than minted here. A request carrying no
// session — the model list — sends none.
export const OPENCODE_ZEN_SESSION_SOURCE_HEADER = 'x-client-request-id';
export const OPENCODE_ZEN_SESSION_HEADER = 'x-opencode-session';

/** Hash the harness id into the shape the gateway accepts; same id in, same id out. */
export function openCodeZenSessionId(conversationId) {
  return `ses_${createHash('sha256').update(conversationId).digest('hex').slice(0, 26)}`;
}

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
  const session = headers.get(OPENCODE_ZEN_SESSION_SOURCE_HEADER);
  if (session) headers.set(OPENCODE_ZEN_SESSION_HEADER, openCodeZenSessionId(session));
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
