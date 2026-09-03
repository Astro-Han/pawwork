'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
	OPENCODE_CLIENT_HEADERS,
	isZeroCost,
	selectFreeAndServed,
	waitForNamespace,
	refreshOpenCodeFreeModels,
} = require('./opencode-free.cjs');

// A catalog shaped like models.dev/api.json (opencode provider).
function catalogWith(models) {
	return { opencode: { api: 'https://opencode.ai/zen/v1', models } };
}

function fetchCatalog(models) {
	return async () => ({ ok: true, json: async () => catalogWith(models) });
}

function settingsHarness(value, descriptor) {
	const writes = [];
	const settings = {
		get: (ns) => ns === 'llm-pi-ai' ? value : undefined,
		async mutate(ns, ops, revision) { writes.push({ ns, ops, revision }); },
	};
	if (descriptor !== undefined) settings.describe = () => [descriptor];
	return { settings, writes };
}

function writtenModels(write, route = 'opencode') {
	return write.ops.find((op) => op.path.at(-1) === 'models' && op.path.at(-2) === route)?.value;
}

test('isZeroCost accepts only fully zero-cost models', () => {
	assert.equal(isZeroCost({ input: 0, output: 0, cache_read: 0, cache_write: 0 }), true);
	assert.equal(isZeroCost({ input: 0, output: 0 }), true);
	// Any present nonzero billable field makes the model paid.
	assert.equal(isZeroCost({ input: 0, output: 1 }), false);
	assert.equal(isZeroCost({ input: 0, cache_read: 1 }), false);
	assert.equal(isZeroCost({ input: 0, cache_write: 1 }), false);
	assert.equal(isZeroCost({ input: 2, output: 12 }), false);
	// Nested paid pricing (tiers / context_over_200k / reasoning / audio) is caught.
	assert.equal(isZeroCost({ input: 0, output: 0, tiers: [{ input: 1, output: 1 }] }), false);
	assert.equal(isZeroCost({ input: 0, output: 0, context_over_200k: { input: 1, output: 1 } }), false);
	assert.equal(isZeroCost({ input: 0, output: 0, reasoning: 1 }), false);
	// The tier descriptor metadata (a context-size threshold, not a price) is ignored.
	assert.equal(isZeroCost({ input: 0, output: 0, tiers: [{ input: 0, output: 0, tier: { type: 'context', size: 200000 } }] }), true);
	// Fail closed: missing/optional pricing fields are not free.
	assert.equal(isZeroCost({ input: 0 }), false);
	assert.equal(isZeroCost({ output: 0 }), false);
	assert.equal(isZeroCost({}), false);
	// Zero-like but non-numeric values are rejected, not coerced.
	assert.equal(isZeroCost({ input: 0, output: null }), false);
	assert.equal(isZeroCost({ input: 0, output: '' }), false);
	assert.equal(isZeroCost({ input: 0, output: false }), false);
	assert.equal(isZeroCost({ input: 0, output: NaN }), false);
	// Non-object inputs are rejected.
	assert.equal(isZeroCost(null), false);
	assert.equal(isZeroCost('0'), false);
	assert.equal(isZeroCost(undefined), false);
	assert.equal(isZeroCost([]), false);
});

test('selectFreeAndServed returns only free AND non-deprecated models, sorted', () => {
	const catalog = catalogWith({
		'new-free': {
			name: 'New Free',
			cost: { input: 0, output: 0 },
			limit: { context: 190000, output: 64000 },
			modalities: { input: ['text', 'image', 'video'] },
			reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'medium', 'high'] }],
		},
		'dead-free': { cost: { input: 0, output: 0 }, status: 'deprecated' },
		'paid': { cost: { input: 2, output: 12 } },
		'free-persisted': { cost: { input: 0, output: 0 }, reasoning: false },
	});
	assert.deepEqual(selectFreeAndServed(catalog), {
		routes: {
			'opencode': [
				{ id: 'free-persisted', reasoningEfforts: false },
				{
					id: 'new-free',
					name: 'New Free',
					contextWindow: 190000,
					maxTokens: 64000,
					input: ['text', 'image'],
					reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
				},
			],
			'opencode-responses': [],
		},
		unroutable: [],
	});
});

// The gateway's endpoint per model is what `provider.npm` records: absent is
// `/chat/completions`, `@ai-sdk/openai` is `/responses`, and the two vendor SDK
// markers name endpoints no PawWork route speaks.
test('selectFreeAndServed splits the free set by the protocol each model is served on', () => {
	const catalog = catalogWith({
		'plain-free': { cost: { input: 0, output: 0 } },
		'responses-free': { cost: { input: 0, output: 0 }, provider: { npm: '@ai-sdk/openai' } },
		'anthropic-free': { cost: { input: 0, output: 0 }, provider: { npm: '@ai-sdk/anthropic' } },
		'google-free': { cost: { input: 0, output: 0 }, provider: { npm: '@ai-sdk/google' } },
	});
	assert.deepEqual(selectFreeAndServed(catalog), {
		routes: {
			'opencode': [{ id: 'plain-free' }],
			'opencode-responses': [{ id: 'responses-free' }],
		},
		unroutable: ['anthropic-free', 'google-free'],
	});
});

test('selectFreeAndServed tolerates missing opencode / models / malformed entries', () => {
	const empty = { routes: { 'opencode': [], 'opencode-responses': [] }, unroutable: [] };
	assert.deepEqual(selectFreeAndServed({}), empty);
	assert.deepEqual(selectFreeAndServed({ opencode: {} }), empty);
	assert.deepEqual(selectFreeAndServed({ opencode: { models: { a: null } } }), empty);
	assert.deepEqual(selectFreeAndServed(null), empty);
	assert.deepEqual(selectFreeAndServed(catalogWith({ a: { cost: { input: 0 } } })), empty);
});

test('waitForNamespace resolves with the registered value', async () => {
	let stored;
	const get = (ns) => (ns === 'llm-pi-ai' ? stored : undefined);
	const pending = waitForNamespace(get, 5000);
	setTimeout(() => {
		stored = { providers: { opencode: { models: [] } } };
	}, 30);
	const value = await pending;
	assert.deepEqual(value, { providers: { opencode: { models: [] } } });
});

test('waitForNamespace returns promptly when aborted', { timeout: 1000 }, async () => {
	const controller = new AbortController();
	const pending = waitForNamespace(() => undefined, 5000, controller.signal);
	setTimeout(() => controller.abort(), 30);
	const value = await pending;
	assert.equal(value, undefined);
});

test('refresh writes free non-deprecated models with serviceable route wiring', async () => {
	const { settings, writes } = settingsHarness({ providers: { opencode: { models: [{ id: 'old' }] } } });
	const fetchImpl = fetchCatalog({
		'hy3-free': { cost: { input: 0, output: 0 } },
		'dead-free': { cost: { input: 0, output: 0 }, status: 'deprecated' },
		'paid': { cost: { input: 2, output: 12 } },
	});
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl });
	assert.equal(count, 1);
	assert.equal(writes.length, 1);
	assert.equal(writes[0].ns, 'llm-pi-ai');
	assert.deepEqual(writes[0].ops, [
		{ op: 'set', path: ['providers', 'opencode', 'api'], value: 'openai-completions' },
		{ op: 'set', path: ['providers', 'opencode', 'baseURL'], value: 'https://opencode.ai/zen/v1' },
		{ op: 'set', path: ['providers', 'opencode', 'headers'], value: OPENCODE_CLIENT_HEADERS },
		{ op: 'set', path: ['providers', 'opencode', 'models'], value: [{ id: 'hy3-free' }] },
	]);
});

test('refresh wires each protocol to its own route in one write', async () => {
	const { settings, writes } = settingsHarness({
		providers: { opencode: { models: [{ id: 'old' }] }, 'opencode-responses': { models: [{ id: 'old-resp' }] } },
	});
	const fetchImpl = fetchCatalog({
		'plain-free': { cost: { input: 0, output: 0 } },
		'responses-free': { cost: { input: 0, output: 0 }, provider: { npm: '@ai-sdk/openai' } },
	});
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl });
	assert.equal(count, 2);
	assert.equal(writes.length, 1);
	assert.deepEqual(writes[0].ops, [
		{ op: 'set', path: ['providers', 'opencode', 'api'], value: 'openai-completions' },
		{ op: 'set', path: ['providers', 'opencode', 'baseURL'], value: 'https://opencode.ai/zen/v1' },
		{ op: 'set', path: ['providers', 'opencode', 'headers'], value: OPENCODE_CLIENT_HEADERS },
		{ op: 'set', path: ['providers', 'opencode', 'models'], value: [{ id: 'plain-free' }] },
		{ op: 'set', path: ['providers', 'opencode-responses', 'api'], value: 'openai-responses' },
		{ op: 'set', path: ['providers', 'opencode-responses', 'baseURL'], value: 'https://opencode.ai/zen/v1' },
		{ op: 'set', path: ['providers', 'opencode-responses', 'headers'], value: OPENCODE_CLIENT_HEADERS },
		{ op: 'set', path: ['providers', 'opencode-responses', 'models'], value: [{ id: 'responses-free' }] },
	]);
});

// `compat` describes one protocol's wire, and a switch another protocol does not
// declare is refused, so a model that moves between routes must not carry it.
test('refresh keeps configured metadata within its own route', async () => {
	const { settings, writes } = settingsHarness({
		providers: {
			opencode: { models: [{ id: 'moved', compat: { chatTemplateKwargs: {} } }] },
			'opencode-responses': { models: [] },
		},
	});
	const fetchImpl = fetchCatalog({
		'moved': { cost: { input: 0, output: 0 }, provider: { npm: '@ai-sdk/openai' } },
	});
	await refreshOpenCodeFreeModels({ settings, fetchImpl });
	assert.deepEqual(writtenModels(writes[0], 'opencode-responses'), [{ id: 'moved' }]);
	// The route the model left keeps its packaged list rather than being emptied.
	assert.equal(writtenModels(writes[0], 'opencode'), undefined);
});

test('refresh leaves a route the live catalog has nothing for untouched', async () => {
	const { settings, writes } = settingsHarness({
		providers: {
			opencode: { api: 'openai-completions', baseURL: 'https://opencode.ai/zen/v1', headers: OPENCODE_CLIENT_HEADERS, models: [{ id: 'plain-free' }] },
			'opencode-responses': { models: [{ id: 'packaged-resp' }] },
		},
	});
	const fetchImpl = fetchCatalog({ 'plain-free': { cost: { input: 0, output: 0 } } });
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl });
	assert.equal(count, 1);
	assert.equal(writes.length, 0);
});

test('refresh reports free models whose protocol no route serves', async () => {
	const warnings = [];
	const { settings } = settingsHarness({ providers: { opencode: { models: [] } } });
	const fetchImpl = fetchCatalog({
		'plain-free': { cost: { input: 0, output: 0 } },
		'anthropic-free': { cost: { input: 0, output: 0 }, provider: { npm: '@ai-sdk/anthropic' } },
	});
	await refreshOpenCodeFreeModels({ settings, fetchImpl, logger: { info() {}, warn(message) { warnings.push(message); } } });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /anthropic-free/);
});

test('refresh moves a dropped default to a model on its own route first', async () => {
	const saves = [];
	const { settings } = settingsHarness({
		providers: { opencode: { models: [{ id: 'plain-free' }] }, 'opencode-responses': { models: [{ id: 'retired' }] } },
	});
	const defaultModel = {
		currentSelection: () => ({ provider: 'opencode-responses', model: 'retired' }),
		async saveSelection(next) { saves.push(next); },
	};
	const fetchImpl = fetchCatalog({
		'plain-free': { cost: { input: 0, output: 0 } },
		'responses-free': { cost: { input: 0, output: 0 }, provider: { npm: '@ai-sdk/openai' } },
	});
	await refreshOpenCodeFreeModels({ settings, defaultModel, fetchImpl });
	assert.deepEqual(saves, [{ provider: 'opencode-responses', model: 'responses-free' }]);
});

test('refresh moves a dropped default across routes when its own route has nothing left', async () => {
	const saves = [];
	const { settings } = settingsHarness({
		providers: { opencode: { models: [] }, 'opencode-responses': { models: [] } },
	});
	const defaultModel = {
		currentSelection: () => ({ provider: 'opencode-responses', model: 'retired' }),
		async saveSelection(next) { saves.push(next); },
	};
	const fetchImpl = fetchCatalog({ 'plain-free': { cost: { input: 0, output: 0 } } });
	await refreshOpenCodeFreeModels({ settings, defaultModel, fetchImpl });
	assert.deepEqual(saves, [{ provider: 'opencode', model: 'plain-free' }]);
});

// A route the refresh left alone still serves its packaged list, so a default
// pointing into it is not "dropped" and must not be moved.
test('refresh keeps a default served by a route the live catalog did not touch', async () => {
	const saves = [];
	const { settings } = settingsHarness({
		providers: { opencode: { models: [] }, 'opencode-responses': { models: [{ id: 'packaged-resp' }] } },
	});
	const defaultModel = {
		currentSelection: () => ({ provider: 'opencode-responses', model: 'packaged-resp' }),
		async saveSelection(next) { saves.push(next); },
	};
	const fetchImpl = fetchCatalog({ 'plain-free': { cost: { input: 0, output: 0 } } });
	await refreshOpenCodeFreeModels({ settings, defaultModel, fetchImpl });
	assert.deepEqual(saves, []);
});

test('refresh does not write an empty list when nothing is usable', async () => {
	const { settings, writes } = settingsHarness({ providers: { opencode: { models: [] } } });
	const fetchImpl = fetchCatalog({ 'dead-free': { cost: { input: 0, output: 0 }, status: 'deprecated' } });
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl });
	assert.equal(count, undefined);
	assert.equal(writes.length, 0);
});

test('refresh leaves the list untouched on a fetch failure', async () => {
	const { settings, writes } = settingsHarness({ providers: { opencode: { models: [] } } });
	const fetchImpl = async () => { throw new Error('network down'); };
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl });
	assert.equal(count, undefined);
	assert.equal(writes.length, 0);
});

test('refresh is bounded by the per-request deadline when a fetch hangs', { timeout: 2000 }, async () => {
	const { settings, writes } = settingsHarness({ providers: { opencode: { models: [] } } });
	// A fetch that never settles would otherwise leave the refresh pending
	// forever; fetchJson must pass a combined signal that aborts on the
	// deadline, which this mock observes and turns into a rejection.
	const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
		init.signal.addEventListener('abort', () => reject(new Error('aborted')));
	});
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl, requestTimeoutMs: 100 });
	assert.equal(count, undefined);
	assert.equal(writes.length, 0);
});

test('refresh never writes while the llm-pi-ai namespace is unregistered', async () => {
	const { settings, writes } = settingsHarness(undefined);
	const count = await refreshOpenCodeFreeModels({ settings, timeoutMs: 30 });
	assert.equal(count, undefined);
	assert.equal(writes.length, 0);
});

test('refresh skips the write when live profiles and routing already match', async () => {
	const { settings, writes } = settingsHarness({
		providers: { opencode: {
			api: 'openai-completions',
			baseURL: 'https://opencode.ai/zen/v1',
			headers: OPENCODE_CLIENT_HEADERS,
			models: [{ id: 'hy3-free' }],
		} },
	});
	const fetchImpl = fetchCatalog({
		'hy3-free': { cost: { input: 0, output: 0 } },
		'paid': { cost: { input: 2, output: 12 } },
	});
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl });
	assert.equal(count, 1); // still reports the usable count
	assert.equal(writes.length, 0); // but nothing was written
});

test('refresh writes when live metadata changes without an id change', async () => {
	const { settings, writes } = settingsHarness({
		providers: { opencode: { models: [{ id: 'hy3-free', contextWindow: 262144 }] } },
	});
	const fetchImpl = fetchCatalog({
		'hy3-free': { cost: { input: 0, output: 0 }, limit: { context: 190000 } },
	});
	await refreshOpenCodeFreeModels({ settings, fetchImpl });
	assert.deepEqual(writtenModels(writes[0]), [{ id: 'hy3-free', contextWindow: 190000 }]);
});

test('refresh writes against the latest settings revision after the catalog request', async () => {
	const initial = { providers: { opencode: { models: [{ id: 'old-model' }] } } };
	const latest = { providers: { opencode: { models: [{ id: 'old-model', compat: { supportsStore: false } }] } } };
	const { settings, writes } = settingsHarness(initial, { ns: 'llm-pi-ai', value: latest, revision: 7 });
	const fetchImpl = fetchCatalog({
		'old-model': { cost: { input: 0, output: 0 }, limit: { context: 190000 } },
	});
	await refreshOpenCodeFreeModels({ settings, fetchImpl });
	assert.equal(writes[0].revision, 7);
	assert.deepEqual(writtenModels(writes[0]), [{ id: 'old-model', contextWindow: 190000, compat: { supportsStore: false } }]);
});

test('refresh moves the opencode default model when it is dropped', async () => {
	const saves = [];
	const { settings, writes } = settingsHarness({ providers: { opencode: { models: [{ id: 'big-pickle' }] } } });
	const defaultModel = {
		currentSelection: () => ({ provider: 'opencode', model: 'big-pickle' }),
		async saveSelection(next) { saves.push(next); },
	};
	const fetchImpl = fetchCatalog({
		'hy3-free': { cost: { input: 0, output: 0 } },
	});
	const count = await refreshOpenCodeFreeModels({ settings, defaultModel, fetchImpl });
	assert.equal(count, 1);
	assert.deepEqual(saves, [{ provider: 'opencode', model: 'hy3-free' }]);
	assert.equal(writes.length, 1);
	assert.deepEqual(writtenModels(writes[0]), [{ id: 'hy3-free' }]);
});

test('refresh clears the previous reasoning effort when moving the default model', async () => {
	const saves = [];
	const { settings } = settingsHarness({ providers: { opencode: { models: [{ id: 'retired' }] } } });
	const defaultModel = {
		currentSelection: () => ({ provider: 'opencode', model: 'retired', reasoningEffort: 'high' }),
		async saveSelection(next) { saves.push(next); },
	};
	const fetchImpl = fetchCatalog({
		'survivor': {
			cost: { input: 0, output: 0 },
			reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
		},
	});
	await refreshOpenCodeFreeModels({ settings, defaultModel, fetchImpl });
	assert.deepEqual(saves, [{ provider: 'opencode', model: 'survivor' }]);
});

test('refresh leaves a non-opencode default untouched', async () => {
	const saves = [];
	const { settings } = settingsHarness({ providers: { opencode: { models: [{ id: 'big-pickle' }] } } });
	const defaultModel = {
		currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
		async saveSelection(next) { saves.push(next); },
	};
	const fetchImpl = fetchCatalog({
		'hy3-free': { cost: { input: 0, output: 0 } },
	});
	await refreshOpenCodeFreeModels({ settings, defaultModel, fetchImpl });
	assert.deepEqual(saves, []);
});

test('product lifecycle immediately refreshes the runtime catalog through settings', { timeout: 2000 }, async (t) => {
	const originalFetch = globalThis.fetch;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-product-lifecycle-'));
	const profileDir = path.join(home, 'profiles', 'web');
	fs.mkdirSync(profileDir, { recursive: true });
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
		dependencies: {},
		dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
	}));
	const hostEnvironment = {
		PAWWORK_DSH_BIN: '/app/dsh/bin.js',
		DSH_HOME: home,
		PAWWORK_NODE_EXECUTABLE: '/app/PawWork',
		PAWWORK_HOST_TOKEN: 'test-host-token',
	};
	const previousEnvironment = Object.fromEntries(
		Object.keys(hostEnvironment).map((name) => [name, process.env[name]]),
	);
	Object.assign(process.env, hostEnvironment);
	const writes = [];
	let dispose;
	let resolveWrite;
	const wrote = new Promise((resolve) => { resolveWrite = resolve; });
	globalThis.fetch = async () => ({
		ok: true,
		json: async () => catalogWith({
			'live-free': { cost: { input: 0, output: 0 }, limit: { context: 190000, output: 64000 } },
		}),
	});
	try {
		const { apply } = await import('./index.js');
		const value = { providers: { opencode: { models: [{ id: 'packaged-free' }] } } };
		apply({
			settings: {
				get: (ns) => ns === 'llm-pi-ai' ? value : undefined,
				describe: () => [{ ns: 'llm-pi-ai', value, revision: 0 }],
				async mutate(ns, ops, revision) {
					writes.push({ ns, ops, revision });
					resolveWrite();
				},
			},
			agentDefaultModel: { currentSelection: () => ({ provider: 'opencode', model: 'live-free' }) },
			provide() {},
			subprocess: { spawn() { throw new Error('unexpected plugin operation'); } },
			webServer: { register() { return () => {}; } },
			logger: { info() {}, warn() {} },
			interval(callback, milliseconds) {
				assert.equal(typeof callback, 'function');
				assert.equal(milliseconds, 60 * 60 * 1000);
			},
			setTimeout() { assert.fail('a successful startup refresh must not schedule a retry'); },
			effect(register) { dispose = register(); },
		});
		await wrote;
		assert.equal(writes.length, 1);
		assert.equal(writes[0].revision, 0);
		assert.deepEqual(writtenModels(writes[0]), [{ id: 'live-free', contextWindow: 190000, maxTokens: 64000 }]);
	} finally {
		dispose?.();
		globalThis.fetch = originalFetch;
		for (const [name, value] of Object.entries(previousEnvironment)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test('product lifecycle retries a failed startup refresh after one and five minutes', { timeout: 2000 }, async (t) => {
	const originalFetch = globalThis.fetch;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-product-retry-'));
	const profileDir = path.join(home, 'profiles', 'web');
	fs.mkdirSync(profileDir, { recursive: true });
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
		dependencies: {},
		dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
	}));
	const hostEnvironment = {
		PAWWORK_DSH_BIN: '/app/dsh/bin.js',
		DSH_HOME: home,
		PAWWORK_NODE_EXECUTABLE: '/app/PawWork',
		PAWWORK_HOST_TOKEN: 'test-host-token',
	};
	const previousEnvironment = Object.fromEntries(
		Object.keys(hostEnvironment).map((name) => [name, process.env[name]]),
	);
	Object.assign(process.env, hostEnvironment);
	let attempts = 0;
	let dispose;
	const scheduled = [];
	globalThis.fetch = async () => {
		attempts += 1;
		throw new Error('network down');
	};
	try {
		const { apply } = await import('./index.js');
		const value = { providers: { opencode: { models: [{ id: 'packaged-free' }] } } };
		apply({
			settings: {
				get: (ns) => ns === 'llm-pi-ai' ? value : undefined,
				describe: () => [{ ns: 'llm-pi-ai', value, revision: 0 }],
				async mutate() { throw new Error('unexpected settings write'); },
			},
			agentDefaultModel: { currentSelection: () => ({ provider: 'opencode', model: 'live-free' }) },
			provide() {},
			subprocess: { spawn() { throw new Error('unexpected plugin operation'); } },
			webServer: { register() { return () => {}; } },
			logger: { info() {}, warn() {} },
			interval() {},
			setTimeout(callback, milliseconds) { scheduled.push({ callback, milliseconds }); },
			effect(register) { dispose = register(); },
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(attempts, 1);
		assert.equal(scheduled[0]?.milliseconds, 60 * 1000);

		scheduled[0].callback();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(attempts, 2);
		assert.equal(scheduled[1]?.milliseconds, 5 * 60 * 1000);

		scheduled[1].callback();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(attempts, 3);
		assert.equal(scheduled.length, 2);
	} finally {
		dispose?.();
		globalThis.fetch = originalFetch;
		for (const [name, value] of Object.entries(previousEnvironment)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

// The gateway admits the free tier by the client identity it is addressed with:
// an unrecognized user-agent is metered in a pool that answers 429 long before
// the desktop-client pool does. A rewrite that drops the shape silently costs
// every user their free access, so pin it.
test('the client identity addresses the gateway as the opencode desktop app', () => {
	assert.match(OPENCODE_CLIENT_HEADERS['user-agent'], /^opencode\/latest\/\d+\.\d+\.\d+\/desktop$/);
	assert.equal(OPENCODE_CLIENT_HEADERS['x-opencode-client'], 'desktop');
	// The adapter drops an attribution default only for a name a route declares,
	// and it compares case-insensitively against its own lowercase spelling.
	assert.deepEqual(Object.keys(OPENCODE_CLIENT_HEADERS), Object.keys(OPENCODE_CLIENT_HEADERS).map((name) => name.toLowerCase()));
});
