'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const { once } = require('events');
const path = require('path');
const { pathToFileURL } = require('url');
const SIDECAR_PRELOAD_HREF = pathToFileURL(path.join(__dirname, 'sidecar-preload.mjs')).href;

function headerRecord(init) {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

function loadIdentity() {
  return import(pathToFileURL(path.join(__dirname, 'zen-identity.mjs')).href);
}

// The module exists to send exactly these two headers: the whole point is the
// value, and every other test here compares the value against the same import,
// so any string would have passed them.
test('sends the official OpenCode desktop identity, not our own', async () => {
  const { OPENCODE_ZEN_HEADERS, OPENCODE_ZEN_HOST } = await loadIdentity();
  assert.deepEqual({ ...OPENCODE_ZEN_HEADERS }, {
    'user-agent': 'opencode/latest/1.18.15/desktop',
    'x-opencode-client': 'desktop',
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

// The id is restated, never minted: the gateway groups a conversation by this
// value, so a fresh one per request would be worse than sending nothing.
test('restates the session id the gateway reads, and invents none', async () => {
  const {
    applyOpenCodeZenHeaders,
    OPENCODE_ZEN_SESSION_HEADER,
    OPENCODE_ZEN_SESSION_SOURCE_HEADER,
  } = await loadIdentity();
  // Spelled out, not compared against the same import: the names are the contract
  // with the gateway, so a rename on both sides has to fail here.
  assert.equal(OPENCODE_ZEN_SESSION_SOURCE_HEADER, 'x-client-request-id');
  assert.equal(OPENCODE_ZEN_SESSION_HEADER, 'x-opencode-session');
  const sessionId = 'session-01513391-0758-4654-9a04-da77af86c553';

  const inference = applyOpenCodeZenHeaders('https://opencode.ai/zen/v1/chat/completions', {
    headers: { [OPENCODE_ZEN_SESSION_SOURCE_HEADER]: sessionId },
  });
  assert.equal(headerRecord(inference)[OPENCODE_ZEN_SESSION_HEADER], sessionId);

  // The settings card's "fetch models" button is the request with no session.
  const models = applyOpenCodeZenHeaders('https://opencode.ai/zen/v1/models', { headers: {} });
  assert.equal(headerRecord(models)[OPENCODE_ZEN_SESSION_HEADER], undefined);
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
      SIDECAR_PRELOAD_HREF,
      '-e',
      'process.stdout.write(String(Boolean(globalThis.fetch && globalThis.fetch.__pawworkZenIdentity)))',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'true');
});

test('Node --import relays the owned shutdown request to signal handlers', async () => {
  const child = spawn(
    process.execPath,
    [
      '--import',
      SIDECAR_PRELOAD_HREF,
      '-e',
      `process.on('SIGTERM', () => setTimeout(() => {
        process.stdout.write('flushed');
        process.exitCode = 0;
      }, 10));
      process.send('ready');`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });

  await once(child, 'message');
  child.send('SIGTERM');
  const forceExit = setTimeout(() => child.kill('SIGKILL'), 500);
  const [code] = await once(child, 'exit');
  clearTimeout(forceExit);

  assert.equal(code, 0);
  assert.equal(stdout, 'flushed');
});
