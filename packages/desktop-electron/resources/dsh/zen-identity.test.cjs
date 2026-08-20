'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');
const ZEN_IDENTITY_PRELOAD_HREF = pathToFileURL(path.join(__dirname, 'zen-identity-preload.mjs')).href;

function headerRecord(init) {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

function loadIdentity() {
  return import(pathToFileURL(path.join(__dirname, 'zen-identity.mjs')).href);
}

// The module exists to send exactly these two headers: the whole point is the
// value, and every other test here compares the value against the same import,
// so any string would have passed them.
test('sends the official OpenCode CLI identity, not our own', async () => {
  const { OPENCODE_ZEN_HEADERS, OPENCODE_ZEN_HOST } = await loadIdentity();
  assert.deepEqual({ ...OPENCODE_ZEN_HEADERS }, {
    'user-agent': 'opencode/latest/1.16.2/cli',
    'x-opencode-client': 'cli',
  });
  assert.equal(OPENCODE_ZEN_HOST, 'opencode.ai');
});

test('recognizes the Zen host and its /zen paths', async () => {
  const { isOpenCodeZenUrl } = await loadIdentity();
  assert.equal(isOpenCodeZenUrl('https://opencode.ai/zen/v1/chat/completions'), true);
  assert.equal(isOpenCodeZenUrl('https://opencode.ai/zen/go/v1/models'), true);
  assert.equal(isOpenCodeZenUrl(new URL('https://opencode.ai/zen/v1')), true);
  assert.equal(isOpenCodeZenUrl('https://api.deepseek.com/chat/completions'), false);
  assert.equal(isOpenCodeZenUrl('https://example.com/zen/v1'), false);
  assert.equal(isOpenCodeZenUrl('not a url'), false);
});

test('replaces User-Agent and keeps the original request headers', async () => {
  const { applyOpenCodeZenHeaders, OPENCODE_ZEN_HEADERS } = await loadIdentity();
  const request = new Request('https://opencode.ai/zen/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer public',
      'user-agent': 'deepseek-harness/0.1.0-rc.6 (+https://github.com/deepseek-ai/deepseek-harness)',
    },
  });
  const next = applyOpenCodeZenHeaders(request);
  assert.deepEqual(headerRecord(next), {
    authorization: 'Bearer public',
    'user-agent': OPENCODE_ZEN_HEADERS['user-agent'],
    'x-opencode-client': OPENCODE_ZEN_HEADERS['x-opencode-client'],
  });
});

test('wraps fetch so only Zen requests carry the official OpenCode identity', async () => {
  const { wrapFetchForOpenCodeZen, OPENCODE_ZEN_HEADERS, OPENCODE_ZEN_HOST } = await loadIdentity();
  const seen = [];
  const wrapped = wrapFetchForOpenCodeZen(async (input, init) => {
    seen.push({ input, headers: headerRecord(init) });
    return new Response('ok');
  });

  await wrapped('https://opencode.ai/zen/v1/chat/completions', {
    headers: { 'user-agent': 'deepseek-harness/0.1.0-rc.6' },
  });
  await wrapped('https://api.deepseek.com/chat/completions', {
    headers: { 'user-agent': 'deepseek-harness/0.1.0-rc.6' },
  });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].headers['user-agent'], OPENCODE_ZEN_HEADERS['user-agent']);
  assert.equal(seen[0].headers['x-opencode-client'], OPENCODE_ZEN_HEADERS['x-opencode-client']);
  assert.equal(seen[1].headers['user-agent'], 'deepseek-harness/0.1.0-rc.6');
  assert.equal(seen[1].headers['x-opencode-client'], undefined);
  assert.equal(OPENCODE_ZEN_HOST, 'opencode.ai');
});

test('apply wraps global fetch once', async () => {
  const { apply, OPENCODE_ZEN_HEADERS } = await loadIdentity();
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, init) => {
    seen.push(headerRecord(init));
    return new Response('ok');
  };
  try {
    apply();
    apply();
    await globalThis.fetch('https://opencode.ai/zen/v1/models', {
      headers: { 'user-agent': 'deepseek-harness/0.1.0-rc.6' },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]['user-agent'], OPENCODE_ZEN_HEADERS['user-agent']);
    assert.equal(globalThis.fetch.__pawworkZenIdentity, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('Node --import wraps fetch before the entry runs', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      ZEN_IDENTITY_PRELOAD_HREF,
      '-e',
      'process.stdout.write(String(Boolean(globalThis.fetch && globalThis.fetch.__pawworkZenIdentity)))',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'true');
});
