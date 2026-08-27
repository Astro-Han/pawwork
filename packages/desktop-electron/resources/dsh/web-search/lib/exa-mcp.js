import { WebError } from '@deepseek-ai/dsh-web';

// Exa's hosted MCP endpoint, reached over Streamable HTTP.
//
// This is the one search backend PawWork cannot borrow from upstream: every
// published provider requires a key, while `mcp.exa.ai` answers unauthenticated
// requests against Exa's own free allowance. v1 shipped exactly this endpoint
// under the "爪印免费额度" label, so a first-run user with no key still gets
// search.
//
// The response is SSE-framed JSON-RPC whose single text block is a rendered
// report, not structured data — Exa exposes no `structuredContent` here. Parsing
// that report is this module's job; everything else defers to the seam.

export const ENDPOINT = 'https://mcp.exa.ai/mcp';
const SEARCH_TOOL = 'web_search_exa';

/** Result blocks Exa renders per hit, in the order it emits them. */
const BLOCK_SEPARATOR = /\n\s*\n(?=Title:\s)/;

/** Statuses that mean Exa declined to serve this caller at all. */
const REFUSAL_STATUS = new Set([401, 402, 403, 429]);

/**
 * Whether Exa is refusing to serve this caller rather than failing to answer.
 *
 * The hosted MCP reports a spent allowance as `isError` prose rather than a
 * status code, so the distinction that decides what a user should do — spend
 * your own key versus try again — only exists in that text.
 * @param text - the error text Exa returned.
 * @returns true when the text describes a refusal.
 */
function isRefusal(text) {
  return /quota|rate.?limit|too many requests|usage limit|payment|unauthorized|forbidden|api key/.test(
    text.toLowerCase(),
  );
}

/**
 * @param refused - whether Exa declined to serve the caller.
 * @returns the seam code to surface.
 */
function codeFor(refused) {
  return refused ? 'WEB_PROVIDER_CREDENTIAL_MISSING' : 'WEB_PROVIDER_ERROR';
}

/**
 * Pull the first complete SSE event's JSON-RPC payload out of a response body.
 *
 * Exa answers one call with one event, but the framing still allows comment and
 * keep-alive lines, so this walks events rather than assuming the body is JSON.
 * @param body - the raw response text.
 * @returns the decoded JSON-RPC envelope.
 * @throws {WebError} when no event carries a decodable payload.
 */
function parseSse(body) {
  const data = [];
  for (const line of body.split(/\r?\n/)) {
    if (line === '') {
      if (data.length > 0) return decodeEvent(data.join('\n'));
      continue;
    }
    if (!line.startsWith('data:')) continue;
    data.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
  }
  if (data.length > 0) return decodeEvent(data.join('\n'));
  throw new WebError('Exa returned no MCP event', 'WEB_PROVIDER_ERROR');
}

/**
 * @param payload - one SSE event's concatenated data lines.
 * @returns the decoded JSON-RPC envelope.
 * @throws {WebError} when the payload is not JSON.
 */
function decodeEvent(payload) {
  try {
    return JSON.parse(payload);
  } catch (cause) {
    throw new WebError('Exa returned a malformed MCP payload', 'WEB_PROVIDER_ERROR', { cause });
  }
}

/**
 * Parse one rendered result block into a seam source.
 *
 * `Title`, `URL` and `Published` are single lines; everything after
 * `Highlights:` is excerpt prose whose leading `>`, `...` elisions and `---`
 * rules are Exa's rendering, not content. The rule is what Exa puts between
 * two results, and it lands inside the preceding block because the split above
 * happens at the blank line before the next `Title:` — so it has to be dropped
 * here or it rides out on that result's snippet.
 * A block without a URL is dropped: the seam's
 * source vocabulary is URL-keyed, and a snippet with nothing to attribute it to
 * would read to the model as an unsourced claim.
 * @param block - one block of the rendered report.
 * @returns the source, or undefined when the block carries no URL.
 */
function parseBlock(block) {
  const fields = new Map();
  const highlights = [];
  let inHighlights = false;
  for (const line of block.split(/\r?\n/)) {
    if (inHighlights) {
      highlights.push(line);
      continue;
    }
    if (/^Highlights:\s*$/.test(line)) {
      inHighlights = true;
      continue;
    }
    const match = /^(Title|URL|Published):\s*(.*)$/.exec(line);
    if (match) fields.set(match[1], match[2].trim());
  }
  const url = fields.get('URL');
  if (url === undefined || url.length === 0) return undefined;
  const title = fields.get('Title');
  const published = fields.get('Published');
  const snippet = highlights
    .map((line) => line.replace(/^>\s?/, '').trim())
    .filter((line) => line.length > 0 && !/^(?:\.{3}|-{3,})$/.test(line))
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
 * Run one search against Exa's hosted MCP on its anonymous allowance.
 *
 * `content` is deliberately omitted: Exa returns retrieved page excerpts, not a
 * generated answer, which is the same choice `@deepseek-ai/dsh-web-search-exa`
 * makes for the official endpoint. `truncated` stays false because the seam owns
 * the final `maxResults` cap.
 * @param options - the query, transport, and budgets for one call.
 * @returns the normalized search result.
 * @throws {WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` when the allowance will
 *   not serve this caller, `WEB_ABORTED` on the caller's abort, and
 *   `WEB_PROVIDER_ERROR` for everything else.
 */
export async function searchViaMcp(options) {
  const { query, maxResults, fetchImpl = fetch, signal, timeoutMs } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
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
    if (signal?.aborted === true) throw new WebError('the search was aborted', 'WEB_ABORTED', { cause });
    const message = timeout.aborted ? 'Exa did not answer in time' : 'could not reach Exa';
    throw new WebError(message, 'WEB_PROVIDER_ERROR', { cause });
  }
  if (!response.ok) {
    throw new WebError(`Exa answered HTTP ${response.status}`, codeFor(REFUSAL_STATUS.has(response.status)));
  }
  // The body streams after the headers resolve, so an abort can land here just
  // as easily as on the request itself, and has to be classified the same way.
  let body;
  try {
    body = await response.text();
  } catch (cause) {
    if (signal?.aborted === true) throw new WebError('the search was aborted', 'WEB_ABORTED', { cause });
    const message = timeout.aborted ? 'Exa did not answer in time' : "could not read Exa's response";
    throw new WebError(message, 'WEB_PROVIDER_ERROR', { cause });
  }
  const envelope = parseSse(body);
  if (envelope.error !== undefined) {
    throw new WebError(`Exa reported ${envelope.error.message ?? 'an MCP error'}`, 'WEB_PROVIDER_ERROR');
  }
  const blocks = envelope.result?.content ?? [];
  const text = blocks.find((block) => block.type === 'text')?.text ?? '';
  if (envelope.result?.isError === true) {
    throw new WebError(text.length > 0 ? text : 'Exa reported a tool error', codeFor(isRefusal(text)));
  }
  return { sources: parseReport(text), truncated: false };
}
