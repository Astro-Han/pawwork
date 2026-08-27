'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ENDPOINT, ExaMcpError, endpointFor, parseReport, parseSse, searchViaMcp } = require('./exa-mcp.cjs');

/** Frame a JSON-RPC envelope the way Exa's Streamable HTTP transport does. */
function sse(envelope) {
  return `event: message\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/** A report block in Exa's rendered shape. */
function block({ title = 'A title', url = 'https://example.com/a', published = 'N/A', highlights = ['An excerpt.'] }) {
  return [`Title: ${title}`, `URL: ${url}`, `Published: ${published}`, 'Author: N/A', 'Highlights:', ...highlights].join('\n');
}

/** Respond with one framed envelope. */
function respondWith(envelope, init = {}) {
  return async () => new Response(sse(envelope), { status: 200, ...init });
}

test('the anonymous endpoint carries no credential', () => {
  assert.equal(endpointFor(undefined), ENDPOINT);
  assert.equal(endpointFor(''), ENDPOINT);
});

test('a personal key rides the endpoint as a query parameter', () => {
  assert.equal(endpointFor('secret-key'), `${ENDPOINT}?exaApiKey=secret-key`);
});

test('parseSse reads the first complete event', () => {
  const body = `: keep-alive\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n`;
  assert.deepEqual(parseSse(body).result, { content: [] });
});

test('parseSse reads a trailing event that has no blank line after it', () => {
  const body = `data: {"result":{"content":[]}}`;
  assert.deepEqual(parseSse(body).result, { content: [] });
});

test('parseSse rejects a body carrying no event', () => {
  assert.throws(() => parseSse('event: message\n\n'), (error) => error instanceof ExaMcpError && error.code === 'WEB_PROVIDER_ERROR');
});

test('parseReport maps each block to a source', () => {
  const sources = parseReport([
    block({ title: 'First', url: 'https://example.com/1', highlights: ['One.'] }),
    block({ title: 'Second', url: 'https://example.com/2', published: '2026-01-02', highlights: ['Two.'] }),
  ].join('\n\n'));
  assert.deepEqual(sources, [
    { url: 'https://example.com/1', title: 'First', snippet: 'One.' },
    { url: 'https://example.com/2', title: 'Second', snippet: 'Two.', publishedAt: '2026-01-02' },
  ]);
});

test('parseReport drops Exa’s rendering marks from the excerpt', () => {
  const [source] = parseReport(block({ highlights: ['> Quoted line.', '...', '> Second line.'] }));
  assert.equal(source.snippet, 'Quoted line. Second line.');
});

test('parseReport omits a date Exa reports as unknown', () => {
  const [source] = parseReport(block({ published: 'N/A' }));
  assert.equal('publishedAt' in source, false);
});

test('parseReport drops a block with no URL', () => {
  assert.deepEqual(parseReport('Title: Orphan\nHighlights:\nNo link.'), []);
});

test('a search returns the parsed sources', async () => {
  const result = await searchViaMcp({
    query: 'anything',
    maxResults: 2,
    timeoutMs: 1000,
    fetchImpl: respondWith({ result: { content: [{ type: 'text', text: block({ title: 'Hit' }) }] } }),
  });
  assert.deepEqual(result, { sources: [{ url: 'https://example.com/a', title: 'Hit', snippet: 'An excerpt.' }], truncated: false });
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

test('an exhausted anonymous allowance reads as a missing credential', async () => {
  await assert.rejects(
    searchViaMcp({
      query: 'anything',
      timeoutMs: 1000,
      fetchImpl: respondWith({ result: { isError: true, content: [{ type: 'text', text: 'Usage limit reached' }] } }),
    }),
    (error) => error instanceof ExaMcpError && error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING',
  );
});

test('a quota failure on a personal key is not reported as a missing credential', async () => {
  await assert.rejects(
    searchViaMcp({
      query: 'anything',
      apiKey: 'a-key',
      timeoutMs: 1000,
      fetchImpl: respondWith({ result: { isError: true, content: [{ type: 'text', text: 'Usage limit reached' }] } }),
    }),
    (error) => error instanceof ExaMcpError && error.code === 'WEB_PROVIDER_ERROR',
  );
});

test('a rejected key reads as a missing credential', async () => {
  await assert.rejects(
    searchViaMcp({
      query: 'anything',
      apiKey: 'a-key',
      timeoutMs: 1000,
      fetchImpl: respondWith({ result: { isError: true, content: [{ type: 'text', text: 'Invalid API key' }] } }),
    }),
    (error) => error instanceof ExaMcpError && error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING',
  );
});

test('a JSON-RPC error surfaces as a provider error', async () => {
  await assert.rejects(
    searchViaMcp({ query: 'anything', timeoutMs: 1000, fetchImpl: respondWith({ error: { code: -32000, message: 'boom' } }) }),
    (error) => error instanceof ExaMcpError && error.code === 'WEB_PROVIDER_ERROR' && /boom/.test(error.message),
  );
});

test('a non-2xx answer surfaces as a provider error', async () => {
  await assert.rejects(
    searchViaMcp({ query: 'anything', timeoutMs: 1000, fetchImpl: async () => new Response('', { status: 500 }) }),
    (error) => error instanceof ExaMcpError && error.code === 'WEB_PROVIDER_ERROR',
  );
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
  await assert.rejects(
    searchViaMcp({
      query: 'anything',
      timeoutMs: 1,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')));
      }),
    }),
    (error) => error instanceof ExaMcpError && error.code === 'WEB_PROVIDER_ERROR',
  );
});
