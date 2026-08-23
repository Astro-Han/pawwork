'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
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

function writtenModels(write) {
	return write.ops.find((op) => op.path.at(-1) === 'models')?.value;
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
	assert.deepEqual(selectFreeAndServed(catalog), [
		{ id: 'free-persisted', reasoningEfforts: false },
		{
			id: 'new-free',
			name: 'New Free',
			contextWindow: 190000,
			maxTokens: 64000,
			input: ['text', 'image'],
			reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
		},
	]);
});

test('selectFreeAndServed tolerates missing opencode / models / malformed entries', () => {
	assert.deepEqual(selectFreeAndServed({}), []);
	assert.deepEqual(selectFreeAndServed({ opencode: {} }), []);
	assert.deepEqual(selectFreeAndServed({ opencode: { models: { a: null } } }), []);
	assert.deepEqual(selectFreeAndServed(null), []);
	assert.deepEqual(selectFreeAndServed(catalogWith({ a: { cost: { input: 0 } } })), []);
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
		{ op: 'set', path: ['providers', 'opencode', 'models'], value: [{ id: 'hy3-free' }] },
	]);
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
	const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-product-lifecycle-'));
	t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
		dependencies: {},
		dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
	}));
	const hostEnvironment = {
		PAWWORK_DSH_BIN: '/app/dsh/bin.js',
		DSH_HOME: path.dirname(profileDir),
		PAWWORK_NODE_EXECUTABLE: '/app/PawWork',
		PAWWORK_DSH_PROFILE_DIR: profileDir,
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
