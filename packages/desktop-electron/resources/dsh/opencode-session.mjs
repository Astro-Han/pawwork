// Process preload: give OpenCode gateway requests the per-conversation id it routes on.
// The gateway rejects an inference request that carries none with `400 MissingSessionID`,
// and it only accepts ids shaped like the ones its own client mints. pi-ai already writes
// the harness session id as `x-client-request-id` once a route asks for the affinity
// headers, so that value is reshaped rather than a new one minted here: same conversation
// in, same id out. Loaded with Node --import before dsh, because llm/stream cannot change
// outbound headers.
import { createHash } from 'node:crypto';

export const OPENCODE_HOST = 'opencode.ai';
export const OPENCODE_SESSION_SOURCE_HEADER = 'x-client-request-id';
export const OPENCODE_SESSION_HEADER = 'x-opencode-session';

/** `ses_` followed by 26 hex characters, the shape the gateway accepts. */
export function openCodeSessionId(conversationId) {
  return `ses_${createHash('sha256').update(conversationId).digest('hex').slice(0, 26)}`;
}

export function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && typeof input.url === 'string') return input.url;
  return '';
}

export function isOpenCodeUrl(input) {
  try {
    const parsed = new URL(requestUrl(input));
    return parsed.hostname === OPENCODE_HOST && parsed.pathname.startsWith('/zen');
  } catch {
    return false;
  }
}

export function applyOpenCodeSession(input, init) {
  const headers = new Headers(init?.headers ?? (input && typeof input === 'object' ? input.headers : undefined));
  const source = headers.get(OPENCODE_SESSION_SOURCE_HEADER);
  // A request carrying no conversation — the model list — sends none.
  if (source) headers.set(OPENCODE_SESSION_HEADER, openCodeSessionId(source));
  return { ...(init || {}), headers };
}

export function wrapFetchForOpenCode(fetchImpl) {
  return function fetchWithOpenCodeSession(input, init) {
    if (!isOpenCodeUrl(input)) return fetchImpl(input, init);
    return fetchImpl(input, applyOpenCodeSession(input, init));
  };
}

export function apply() {
  if (globalThis.fetch && globalThis.fetch.__pawworkOpenCodeSession) return;
  const original = globalThis.fetch;
  if (typeof original !== 'function') return;
  const wrapped = wrapFetchForOpenCode(original.bind(globalThis));
  wrapped.__pawworkOpenCodeSession = true;
  globalThis.fetch = wrapped;
}
