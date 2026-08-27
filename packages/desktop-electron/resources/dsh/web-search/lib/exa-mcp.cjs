'use strict';

// Exa's hosted MCP endpoint, reached over Streamable HTTP.
//
// This is the one search backend PawWork cannot borrow from upstream: every
// published provider requires a key, while `mcp.exa.ai` answers unauthenticated
// requests against Exa's own free allowance. v1 shipped exactly this endpoint
// under the "爪印免费额度" label, so a first-run user with no key still gets
// search. A personal key rides the same endpoint as `?exaApiKey=`, which is how
// Exa scopes the call to that key's quota rather than the shared one.
//
// The response is SSE-framed JSON-RPC whose single text block is a rendered
// report, not structured data — Exa exposes no `structuredContent` here. Parsing
// that report is this module's job; everything else defers to the seam.

const ENDPOINT = 'https://mcp.exa.ai/mcp';
const SEARCH_TOOL = 'web_search_exa';

/** Result blocks Exa renders per hit, in the order it emits them. */
const BLOCK_SEPARATOR = /\n\s*\n(?=Title:\s)/;

/**
 * Address the endpoint for one credential.
 *
 * The key travels as a query parameter because that is the only channel Exa's
 * hosted MCP accepts it on; an absent key is not an error but the anonymous
 * allowance, so this returns the bare URL rather than failing.
 * @param apiKey - the caller's Exa key, or undefined for the free allowance.
 * @returns the URL to POST the JSON-RPC call to.
 */
function endpointFor(apiKey) {
  if (apiKey === undefined || apiKey.length === 0) return ENDPOINT;
  const url = new URL(ENDPOINT);
  url.searchParams.set('exaApiKey', apiKey);
  return url.toString();
}

/**
 * An error carrying the seam code the caller should surface.
 *
 * The module throws these rather than `WebError` so it stays a plain CommonJS
 * unit the host half can test without loading the ESM seam.
 */
class ExaMcpError extends Error {
  /**
   * @param code - the `WebError` code this failure maps to.
   * @param message - operator-facing detail.
   * @param options - standard error options (`cause`).
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ExaMcpError';
    this.code = code;
  }
}

/**
 * Pull the first complete SSE event's JSON-RPC payload out of a response body.
 *
 * Exa answers one call with one event, but the framing still allows comment and
 * keep-alive lines, so this walks events rather than assuming the body is JSON.
 * @param body - the raw response text.
 * @returns the decoded JSON-RPC envelope.
 * @throws {ExaMcpError} when no event carries a decodable payload.
 */
function parseSse(body) {
  let data = [];
  let sawData = false;
  for (const line of body.split(/\r?\n/)) {
    if (line === '') {
      if (data.length > 0) return decodeEvent(data.join('\n'));
      continue;
    }
    if (!line.startsWith('data:')) continue;
    sawData = true;
    data.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
  }
  if (data.length > 0) return decodeEvent(data.join('\n'));
  throw new ExaMcpError(
    'WEB_PROVIDER_ERROR',
    sawData ? 'Exa returned an empty MCP response' : 'Exa returned no MCP event',
  );
}

/**
 * @param payload - one SSE event's concatenated data lines.
 * @returns the decoded JSON-RPC envelope.
 * @throws {ExaMcpError} when the payload is not JSON.
 */
function decodeEvent(payload) {
  try {
    return JSON.parse(payload);
  } catch (cause) {
    throw new ExaMcpError('WEB_PROVIDER_ERROR', 'Exa returned a malformed MCP payload', { cause });
  }
}

/**
 * Classify a failure Exa reports in prose.
 *
 * The hosted MCP reports quota and key problems as `isError` text rather than a
 * status code, so the distinction that matters to a user — "the free allowance
 * ran out" versus "the key you saved is wrong" — only exists in that text.
 * @param text - the error text Exa returned.
 * @param authenticated - whether the call carried a key.
 * @returns the seam code to surface.
 */
function classify(text, authenticated) {
  const lowered = text.toLowerCase();
  if (/quota|rate.?limit|too many requests|usage limit|payment|402|429/.test(lowered)) {
    return authenticated ? 'WEB_PROVIDER_ERROR' : 'WEB_PROVIDER_CREDENTIAL_MISSING';
  }
  if (/invalid|unauthorized|forbidden|api key|401|403/.test(lowered)) {
    return 'WEB_PROVIDER_CREDENTIAL_MISSING';
  }
  return 'WEB_PROVIDER_ERROR';
}

/**
 * Parse one rendered result block into a seam source.
 *
 * `Title`, `URL`, `Published` and `Author` are single lines; everything after
 * `Highlights:` is excerpt prose whose leading `>` and `...` separators are
 * Exa's rendering, not content. A block without a URL is dropped: the seam's
 * source vocabulary is URL-keyed, and a snippet with nothing to attribute it to
 * would read to the model as an unsourced claim.
 * @param block - one block of the rendered report.
 * @returns the source, or undefined when the block carries no URL.
 */
function parseBlock(block) {
  const lines = block.split(/\r?\n/);
  const fields = new Map();
  let highlights = [];
  let inHighlights = false;
  for (const line of lines) {
    if (inHighlights) {
      highlights.push(line);
      continue;
    }
    if (/^Highlights:\s*$/.test(line)) {
      inHighlights = true;
      continue;
    }
    const match = /^(Title|URL|Published|Author):\s*(.*)$/.exec(line);
    if (match) fields.set(match[1], match[2].trim());
  }
  const url = fields.get('URL');
  if (url === undefined || url.length === 0) return undefined;
  const title = fields.get('Title');
  const published = fields.get('Published');
  const snippet = highlights
    .map((line) => line.replace(/^>\s?/, '').trim())
    .filter((line) => line.length > 0 && line !== '...')
    .join(' ')
    .trim();
  return {
    url,
    ...(title !== undefined && title.length > 0 ? { title } : {}),
    ...(snippet.length > 0 ? { snippet } : {}),
    // Exa renders a missing date as the literal "N/A"; passing that through
    // would put a fake timestamp in front of the model.
    ...(published !== undefined && published.length > 0 && published !== 'N/A'
      ? { publishedAt: published }
      : {}),
  };
}

/**
 * Parse the rendered report into seam sources.
 * @param text - the single text block Exa returned.
 * @returns the sources, in the order Exa ranked them.
 */
function parseReport(text) {
  return text
    .split(BLOCK_SEPARATOR)
    .map((block) => parseBlock(block.trim()))
    .filter((source) => source !== undefined);
}

/**
 * Run one search against Exa's hosted MCP.
 *
 * `content` is deliberately omitted: Exa returns retrieved page excerpts, not a
 * generated answer, which is the same choice `@deepseek-ai/dsh-web-search-exa`
 * makes for the official endpoint. `truncated` stays false because the seam owns
 * the final `maxResults` cap.
 * @param options - the query, credential, transport, and budgets for one call.
 * @returns the normalized search result.
 * @throws {ExaMcpError} when the call cannot be made or its answer represented.
 */
async function searchViaMcp(options) {
  const { query, maxResults, apiKey, fetchImpl = fetch, signal, timeoutMs } = options;
  const authenticated = apiKey !== undefined && apiKey.length > 0;
  const timeout = AbortSignal.timeout(timeoutMs);
  const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response;
  try {
    response = await fetchImpl(endpointFor(apiKey), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: SEARCH_TOOL,
          arguments: { query, ...(maxResults === undefined ? {} : { numResults: maxResults }) },
        },
      }),
      signal: composed,
      redirect: 'error',
    });
  } catch (cause) {
    // A caller's abort and our own deadline both surface as AbortError here;
    // only the caller's is the seam's `WEB_ABORTED`.
    if (signal?.aborted === true) throw new ExaMcpError('WEB_ABORTED', 'the search was aborted', { cause });
    if (timeout.aborted) throw new ExaMcpError('WEB_PROVIDER_ERROR', 'Exa did not answer in time', { cause });
    throw new ExaMcpError('WEB_PROVIDER_ERROR', 'could not reach Exa', { cause });
  }
  if (!response.ok) {
    throw new ExaMcpError(
      classify(`${response.status}`, authenticated),
      `Exa answered HTTP ${response.status}`,
    );
  }
  const envelope = parseSse(await response.text());
  if (envelope.error !== undefined) {
    throw new ExaMcpError('WEB_PROVIDER_ERROR', `Exa reported ${envelope.error.message ?? 'an MCP error'}`);
  }
  const blocks = envelope.result?.content ?? [];
  const text = blocks.find((block) => block.type === 'text')?.text ?? '';
  if (envelope.result?.isError === true) {
    throw new ExaMcpError(classify(text, authenticated), text.length > 0 ? text : 'Exa reported a tool error');
  }
  return { sources: parseReport(text), truncated: false };
}

module.exports = { ENDPOINT, ExaMcpError, endpointFor, parseReport, parseSse, searchViaMcp };
