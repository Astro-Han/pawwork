import { WebError } from '@deepseek-ai/dsh-web';

// Exa's hosted MCP endpoint, reached over Streamable HTTP.
//
// This is the one search backend PawWork cannot borrow from upstream: every
// published provider requires a key, while `mcp.exa.ai` answers unauthenticated
// requests against Exa's own free allowance. v1 shipped exactly this endpoint
// under the "爪印免费额度" label, so a first-run user with no key still gets
// search.
//
// The answer is a rendered report, and this module hands it to the seam as
// `content` with no `sources`. That is the whole design decision, so it is
// worth stating why.
//
// Exa renders each result as `Title:` / `URL:` / `Published:` / `Highlights:`
// separated by a rule, and everything under `Highlights:` is verbatim page
// text. Splitting that report back into attributed sources means deciding which
// bytes are Exa's structure and which are a page's content — and the report
// does not carry that distinction. Any rule a parser applies, a page can print.
// Three boundary rules shipped here and each one both minted sources a page
// authored and truncated pages that did nothing wrong; a fourth would too. The
// count is no backstop either: it binds only when Exa fills the request, and
// when it does bind it evicts real results rather than forged ones.
//
// So the report is passed through whole. The model reads exactly the bytes it
// read before — Exa's own formatting of the titles, links and excerpts, which
// `dsh-tool-web` renders ahead of any source list — and nothing in this product
// vouches for a structure it cannot verify. The keyed Exa path is unaffected:
// `api.exa.ai` returns real structured results, which `ExaSearchProvider` maps.
//
// `tools/list` confirms the endpoint offers no `outputSchema` and no structured
// output option, so this is a property of the free tier, not an oversight.

export const ENDPOINT = 'https://mcp.exa.ai/mcp';
const SEARCH_TOOL = 'web_search_exa';

/** Statuses that mean Exa declined to serve this caller at all. */
const REFUSAL_STATUS = new Set([401, 402, 403]);

/** Statuses that mean Exa wants this caller to come back later. */
const TRANSIENT_STATUS = new Set([429, 503]);

/**
 * What to say when Exa's shared allowance reports a failure in prose.
 *
 * The hosted MCP answers a spent allowance, a throttle and an outage the same
 * way: HTTP 200, `isError`, and an English sentence. Those demand different
 * things of a user, and this module used to guess between them with keyword
 * regexes over a string that also echoes the user's own query — which got it
 * wrong in both directions, telling people to go buy a key when a burst was
 * throttled and to wait when the allowance was genuinely spent.
 *
 * The distinction is not recoverable from the data, so it is not attempted.
 * Both remedies are named instead, cheapest first. Status codes still classify,
 * because those are a protocol rather than prose.
 */
const PROSE_FAILURE_MESSAGE =
  "Exa's shared free allowance did not complete this search. It may be " +
  'temporarily rate-limited, or the free allowance may be used up. Try again ' +
  'shortly, or open Settings → Plugins → Web search and enter your own Exa ' +
  'API key.';

/**
 * Pull the JSON-RPC envelope out of a response body.
 *
 * Streamable HTTP lets the server answer one call as either SSE or plain JSON,
 * and this request declares it accepts both, so both are decoded. Exa answers
 * with one SSE event today; the framing still allows comment and keep-alive
 * lines, so this walks events rather than assuming a single frame.
 * @param body - the raw response text.
 * @returns the decoded JSON-RPC envelope.
 * @throws {WebError} when no event carries a decodable payload.
 */
function parseSse(body) {
  if (body.trimStart().startsWith('{')) return decodeEvent(body);
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
 * Read the rendered report out of a tool result.
 *
 * Shape is checked rather than assumed. The body is third-party JSON, and a
 * shape this module does not expect is a provider failure it can report, not a
 * `TypeError` escaping into a seam that has no vocabulary for one.
 * @param result - the JSON-RPC result member, whatever it turned out to be.
 * @returns the concatenated text blocks, empty when there are none.
 */
function reportText(result) {
  if (typeof result !== 'object' || result === null) return '';
  const blocks = result.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => typeof block === 'object' && block !== null && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n\n');
}

/**
 * Run one search against Exa's hosted MCP on its anonymous allowance.
 *
 * The report is returned as `content` and `sources` stays empty — see the note
 * at the top of this file. `truncated` stays false because `numResults` already
 * asked for the cap the seam wants.
 * @param options - the query, transport, and budgets for one call.
 * @returns the normalized search result.
 * @throws {WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` when Exa's status says it
 *   will not serve this caller, `WEB_ABORTED` on the caller's abort, and
 *   `WEB_PROVIDER_ERROR` for everything else.
 */
export async function searchViaMcp(options) {
  const { query, maxResults, fetchImpl = fetch, signal } = options;
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
      signal,
      redirect: 'error',
    });
  } catch (cause) {
    if (signal?.aborted === true) throw new WebError('the search was aborted', 'WEB_ABORTED', { cause });
    throw new WebError('could not reach Exa', 'WEB_PROVIDER_ERROR', { cause });
  }
  if (!response.ok) {
    if (TRANSIENT_STATUS.has(response.status)) {
      throw new WebError(
        `Exa is throttling this deployment (HTTP ${response.status}); try again shortly`,
        'WEB_PROVIDER_ERROR',
      );
    }
    const code = REFUSAL_STATUS.has(response.status) ? 'WEB_PROVIDER_CREDENTIAL_MISSING' : 'WEB_PROVIDER_ERROR';
    throw new WebError(`Exa answered HTTP ${response.status}`, code);
  }
  // The body streams after the headers resolve, so an abort can land here just
  // as easily as on the request itself, and has to be classified the same way.
  let body;
  try {
    body = await response.text();
  } catch (cause) {
    if (signal?.aborted === true) throw new WebError('the search was aborted', 'WEB_ABORTED', { cause });
    throw new WebError("could not read Exa's response", 'WEB_PROVIDER_ERROR', { cause });
  }
  const envelope = parseSse(body);
  if (typeof envelope !== 'object' || envelope === null) {
    throw new WebError('Exa returned a malformed MCP payload', 'WEB_PROVIDER_ERROR');
  }
  if (envelope.error !== undefined && envelope.error !== null) {
    throw new WebError(`Exa reported ${envelope.error.message ?? 'an MCP error'}`, 'WEB_PROVIDER_ERROR');
  }
  const text = reportText(envelope.result);
  if (envelope.result?.isError === true) {
    throw new WebError(PROSE_FAILURE_MESSAGE, 'WEB_PROVIDER_ERROR', {
      cause: text.length > 0 ? new Error(text) : undefined,
    });
  }
  // An answer we cannot read is a failure, not an empty result set. The seam
  // renders a result with neither content nor sources as "No results found.",
  // so returning one here would have the model tell the user the web holds
  // nothing on the subject — the one outcome on this path that is confidently
  // wrong rather than merely broken. A genuine zero-hit search still arrives as
  // a report Exa rendered, which is non-empty text and passes through.
  if (text.length === 0) {
    throw new WebError('Exa returned no readable result', 'WEB_PROVIDER_ERROR');
  }
  return { content: text, sources: [], truncated: false };
}
