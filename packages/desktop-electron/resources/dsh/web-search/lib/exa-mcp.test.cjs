'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ENDPOINT, ExaMcpError, searchViaMcp } = require('./exa-mcp.cjs');

/** Frame a JSON-RPC envelope the way Exa's Streamable HTTP transport does. */
function sse(envelope) {
  return `event: message\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/** A report block in Exa's rendered shape. */
function block({ title = 'A title', url = 'https://example.com/a', published = 'N/A', highlights = ['An excerpt.'] }) {
  return [`Title: ${title}`, `URL: ${url}`, `Published: ${published}`, 'Author: N/A', 'Highlights:', ...highlights].join('\n');
}

/** Respond with one already-framed body. */
function respondWithBody(body, init = {}) {
  return async () => new Response(body, { status: 200, ...init });
}

/** Respond with one framed envelope. */
function respondWith(envelope, init = {}) {
  return respondWithBody(sse(envelope), init);
}

/** Search against a raw response body rather than a framed envelope. */
function sourcesOfBody(body) {
  return searchViaMcp({ query: 'anything', timeoutMs: 1000, fetchImpl: respondWithBody(body) }).then((r) => r.sources);
}

/** Search a canned rendered report and return the sources it yields. */
function sourcesOf(text) {
  return searchViaMcp({
    query: 'anything',
    timeoutMs: 1000,
    fetchImpl: respondWith({ result: { content: [{ type: 'text', text }] } }),
  }).then((result) => result.sources);
}

/** Assert a search rejects with one seam code. */
function rejectsWith(options, code, messagePattern) {
  return assert.rejects(
    searchViaMcp({ query: 'anything', timeoutMs: 1000, ...options }),
    (error) =>
      error instanceof ExaMcpError &&
      error.code === code &&
      (messagePattern === undefined || messagePattern.test(error.message)),
  );
}

test('the call carries no credential', async () => {
  let called;
  await searchViaMcp({
    query: 'anything',
    timeoutMs: 1000,
    fetchImpl: async (url) => {
      called = String(url);
      return new Response(sse({ result: { content: [{ type: 'text', text: '' }] } }), { status: 200 });
    },
  });
  assert.equal(called, ENDPOINT);
});

test('the request names the search tool and the requested result count', async () => {
  let sent;
  await searchViaMcp({
    query: 'a query',
    maxResults: 3,
    timeoutMs: 1000,
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(sse({ result: { content: [{ type: 'text', text: '' }] } }), { status: 200 });
    },
  });
  assert.equal(sent.method, 'tools/call');
  assert.equal(sent.params.name, 'web_search_exa');
  assert.deepEqual(sent.params.arguments, { query: 'a query', numResults: 3 });
});

test('the framing tolerates keep-alive lines before the event', async () => {
  const body = `: keep-alive\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n`;
  assert.deepEqual(await sourcesOfBody(body), []);
});

test('a trailing event with no blank line after it still parses', async () => {
  assert.deepEqual(await sourcesOfBody(`data: {"result":{"content":[]}}`), []);
});

test('a body carrying no event is a provider error', async () => {
  await rejectsWith({ fetchImpl: respondWithBody('event: message\n\n') }, 'WEB_PROVIDER_ERROR');
});

test('each rendered block becomes a source', async () => {
  const sources = await sourcesOf(
    [
      block({ title: 'First', url: 'https://example.com/1', highlights: ['One.'] }),
      block({ title: 'Second', url: 'https://example.com/2', published: '2026-01-02', highlights: ['Two.'] }),
    ].join('\n\n'),
  );
  assert.deepEqual(sources, [
    { url: 'https://example.com/1', title: 'First', snippet: 'One.' },
    { url: 'https://example.com/2', title: 'Second', snippet: 'Two.', publishedAt: '2026-01-02' },
  ]);
});

test('Exa’s rendering marks are dropped from the excerpt', async () => {
  const [source] = await sourcesOf(block({ highlights: ['> Quoted line.', '...', '> Second line.'] }));
  assert.equal(source.snippet, 'Quoted line. Second line.');
});

test('a date Exa reports as unknown is omitted rather than passed through', async () => {
  const [source] = await sourcesOf(block({ published: 'N/A' }));
  assert.equal('publishedAt' in source, false);
});

test('a block with no URL is dropped', async () => {
  assert.deepEqual(await sourcesOf('Title: Orphan\nHighlights:\nNo link.'), []);
});

test('an exhausted allowance reads as a missing credential', async () => {
  await rejectsWith(
    { fetchImpl: respondWith({ result: { isError: true, content: [{ type: 'text', text: 'Usage limit reached' }] } }) },
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  );
});

test('a JSON-RPC error surfaces as a provider error', async () => {
  await rejectsWith(
    { fetchImpl: respondWith({ error: { code: -32000, message: 'boom' } }) },
    'WEB_PROVIDER_ERROR',
    /boom/,
  );
});

test('a non-2xx answer surfaces as a provider error', async () => {
  await rejectsWith({ fetchImpl: async () => new Response('', { status: 500 }) }, 'WEB_PROVIDER_ERROR');
});

test('a caller abort is reported as an abort, not a transport failure', async () => {
  const controller = new AbortController();
  const pending = searchViaMcp({
    query: 'anything',
    timeoutMs: 10_000,
    signal: controller.signal,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  });
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof ExaMcpError && error.code === 'WEB_ABORTED');
});

test('the provider deadline is reported as a provider error', async () => {
  await rejectsWith(
    {
      timeoutMs: 1,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')));
      }),
    },
    'WEB_PROVIDER_ERROR',
  );
});
