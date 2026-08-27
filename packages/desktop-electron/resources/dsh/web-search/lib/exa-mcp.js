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

// The boundary between two rendered results: Exa's rule *and* the header pair
// that opens the next result.
//
// Neither half is sufficient, because highlight text is verbatim third-party
// page content and either half alone appears in ordinary prose. On the rule
// alone, any page carrying a horizontal rule — a common thing for a page to
// carry — splits into two blocks: the tail of a real result is dropped and a
// second entry is minted, ranked, dated and attributed to whatever URL the page
// chose to print. On the header pair alone, a bibliography or a citation example
// does the same. Requiring both costs a page far more than it costs Exa, whose
// renderer emits them together by construction.
//
// Measured against 18 live captures of eight results each: the rule alone
// over-splits three of them, the pair with the rule splits all 18 into exactly
// eight.
const BLOCK_BOUNDARY = /\n\s*\n-{3,}\n\s*\n(?=Title:.*\r?\nURL:\s*\S)/;

/** Schemes a source may carry; the rendered report is not a trusted origin. */
const ALLOWED_SCHEME = /^https?:\/\//i;

/** Statuses that mean Exa declined to serve this caller at all. */
const REFUSAL_STATUS = new Set([401, 402, 403]);

/** Statuses that mean Exa wants this caller to come back later. */
const TRANSIENT_STATUS = new Set([429, 503]);

/**
 * The prefix of a failure text that decides its classification.
 *
 * Exa's errors lead with the reason and may go on to quote the request, so
 * classifying the whole text lets a query about rate limits or API keys decide
 * how its own failure is reported.
 */
const CLASSIFIED_PREFIX_CHARS = 240;

/**
 * The part of a failure text that describes the failure.
 *
 * Quoted spans are dropped because that is where Exa echoes the request:
 * `Search failed for query: "rotate an openai api key"` describes a broken
 * search, not a missing credential, and the words that would say otherwise are
 * the user's own. They are dropped *before* the prefix is taken, or a long
 * enough query fills the window on its own and the reason never gets classified.
 *
 * Only double quotes are stripped. Exa quotes the query with them, while a
 * single quote in this text is an apostrophe far more often than a delimiter —
 * treating it as one swallows the sentence it appears in.
 * @param text - the error text Exa returned.
 * @returns the classifiable prose, lowercased.
 */
function classifiable(text) {
  return text.replace(/"[^"]*"/g, ' ').slice(0, CLASSIFIED_PREFIX_CHARS).toLowerCase();
}

/**
 * Whether Exa is refusing to serve this caller rather than failing to answer.
 *
 * The hosted MCP reports a spent allowance as `isError` prose rather than a
 * status code, so the distinction that decides what a user should do — spend
 * your own key versus wait — exists only in that text.
 * @param text - the error text Exa returned.
 * @returns true when the text describes a refusal.
 */
function isRefusal(text) {
  return /quota|usage limit|allowance|free tier|credit|exhausted|expired|suspended|payment|unauthorized|forbidden|api key/.test(
    classifiable(text),
  );
}

/**
 * Whether Exa is asking this caller to come back later.
 *
 * Kept apart from a refusal because the two demand opposite actions: sending a
 * user to buy a key because a burst was throttled costs them money that waiting
 * ten seconds would have saved.
 *
 * Only phrases that name a *rate* count. "try again later" and "temporarily"
 * read as transient but are polite padding that a spent allowance carries too —
 * Exa's own wording is "You have exhausted your free tier quota. Please try
 * again later." — and because this test is read first, admitting them meant the
 * one message that should send a user to add a key was the one that never did.
 * @param text - the error text Exa returned.
 * @returns true when the text describes a transient limit.
 */
function isTransient(text) {
  return /rate.?limit|too many requests|overloaded|timed? ?out/.test(classifiable(text));
}

/**
 * Classify one failure text into a seam code.
 *
 * Three outcomes, not two — refused, throttled, broken — with throttling read
 * first so a message that names both a rate limit and an API key is treated as
 * the retryable one.
 * @param text - the error text Exa returned.
 * @returns the seam code to surface.
 */
function codeForText(text) {
  if (isTransient(text)) return 'WEB_PROVIDER_ERROR';
  return isRefusal(text) ? 'WEB_PROVIDER_CREDENTIAL_MISSING' : 'WEB_PROVIDER_ERROR';
}

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
 * Join a block's excerpt lines into one snippet, keeping the elisions.
 *
 * Exa separates excerpts with a `...` line. Collapsing consecutive blank and
 * `...` lines into a single ellipsis keeps the seam value one line while still
 * telling the model where the page was cut.
 * @param lines - the raw lines following `Highlights:`.
 * @returns the joined snippet.
 */
function joinExcerpts(lines) {
  const parts = [];
  for (const line of lines) {
    const text = line.trim();
    if (text.length === 0 || text === '...') {
      if (parts.length > 0 && parts.at(-1) !== '…') parts.push('…');
      continue;
    }
    parts.push(text);
  }
  if (parts.at(-1) === '…') parts.pop();
  return parts.join(' ');
}

/**
 * Parse one rendered result block into a seam source.
 *
 * `Title`, `URL` and `Published` are single lines; everything after
 * `Highlights:` is excerpt prose.
 *
 * A block is dropped unless it carries an `http(s)` URL. The seam's source
 * vocabulary is URL-keyed, so a snippet with nothing to attribute it to reads to
 * the model as an unsourced claim; and the URL arrives inside third-party page
 * text, so the scheme is checked rather than assumed.
 * @param block - one block of the rendered report.
 * @returns the source, or undefined when the block carries no usable URL.
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
  if (url === undefined || !ALLOWED_SCHEME.test(url)) return undefined;
  const title = fields.get('Title');
  const published = fields.get('Published');
  const snippet = joinExcerpts(highlights);
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
 *
 * The count is ours and the text is theirs, so the count is what bounds the
 * parse: we asked for `maxResults` results and Exa cannot rank more than it was
 * asked for. Any block past that came from inside a page, so it is folded back
 * into the block before it — where its text still reads to the model as an
 * excerpt of the page that wrote it, rather than as a source of its own.
 * @param text - the rendered report Exa returned.
 * @param maxResults - the result count this call requested, when it named one.
 * @returns the sources, in the order Exa ranked them.
 */
function parseReport(text, maxResults) {
  const blocks = text.split(BLOCK_BOUNDARY);
  const limit = maxResults !== undefined && maxResults >= 1 ? maxResults : blocks.length;
  const bounded =
    blocks.length <= limit
      ? blocks
      : [...blocks.slice(0, limit - 1), blocks.slice(limit - 1).join('\n\n')];
  return bounded.map((block) => parseBlock(block.trim())).filter((source) => source !== undefined);
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
    if (TRANSIENT_STATUS.has(response.status)) {
      throw new WebError(`Exa is throttling this deployment (HTTP ${response.status}); try again shortly`, 'WEB_PROVIDER_ERROR');
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
    const message = timeout.aborted ? 'Exa did not answer in time' : "could not read Exa's response";
    throw new WebError(message, 'WEB_PROVIDER_ERROR', { cause });
  }
  const envelope = parseSse(body);
  if (envelope.error !== undefined) {
    throw new WebError(`Exa reported ${envelope.error.message ?? 'an MCP error'}`, 'WEB_PROVIDER_ERROR');
  }
  const blocks = envelope.result?.content ?? [];
  // Joined on the rule Exa renders between results, not on a blank line: two
  // content blocks are two pieces of the report, so a plain join would have the
  // second one's header read as excerpt prose belonging to the last result of
  // the first.
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n\n---\n\n');
  if (envelope.result?.isError === true) {
    throw new WebError(text.length > 0 ? text : 'Exa reported a tool error', codeForText(text));
  }
  // An answer we cannot read is a failure, not an empty result set. The seam
  // renders zero sources as "No results found.", so returning `[]` here would
  // have the model tell the user the web holds nothing on the subject — the one
  // outcome on this path that is confidently wrong rather than merely broken.
  // A genuine zero-hit search still arrives as a report Exa rendered, which
  // parses to `[]` further down and is left alone.
  if (envelope.result === undefined || text.length === 0) {
    throw new WebError('Exa returned no readable result', 'WEB_PROVIDER_ERROR');
  }
  return { sources: parseReport(text, maxResults), truncated: false };
}
