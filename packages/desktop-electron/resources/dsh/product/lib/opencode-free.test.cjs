'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
	isZeroCost,
	selectFreeAndServed,
	waitForNamespace,
	refreshOpenCodeFreeModels,
	sameModelIds,
	configuredModelIds,
	mergeModelEntries,
} = require('./opencode-free.cjs');

// A catalog shaped like models.dev/api.json (opencode provider).
function catalogWith(models) {
	return { opencode: { api: 'https://opencode.ai/zen/v1', models } };
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
		'new-free': { cost: { input: 0, output: 0 } },
		'dead-free': { cost: { input: 0, output: 0 }, status: 'deprecated' },
		'paid': { cost: { input: 2, output: 12 } },
		'free-persisted': { cost: { input: 0, output: 0 } },
	});
	assert.deepEqual(selectFreeAndServed(catalog), [
		{ id: 'free-persisted' },
		{ id: 'new-free' },
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

test('waitForNamespace times out without a registered namespace', async () => {
	const value = await waitForNamespace(() => undefined, 50);
	assert.equal(value, undefined);
});

test('waitForNamespace aborts promptly when the signal fires', async () => {
	const controller = new AbortController();
	const pending = waitForNamespace(() => undefined, 5000, controller.signal);
	setTimeout(() => controller.abort(), 30);
	const value = await pending;
	assert.equal(value, undefined);
});

test('refresh writes free non-deprecated models plus route wiring via settings.mutate', async () => {
	const writes = [];
	const settings = {
		get: (ns) => ns === 'llm-pi-ai' ? { providers: { opencode: { models: [{ id: 'old' }] } } } : undefined,
		async mutate(ns, ops, revision) {
			writes.push({ ns, ops, revision });
		},
	};
	const fetchImpl = async () => ({
		ok: true,
		json: async () => catalogWith({
			'hy3-free': { cost: { input: 0, output: 0 } },
			'dead-free': { cost: { input: 0, output: 0 }, status: 'deprecated' },
			'paid': { cost: { input: 2, output: 12 } },
		}),
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
	assert.equal(writes[0].revision, undefined);
});

test('refresh does not write an empty list when nothing is usable', async () => {
	const writes = [];
	const settings = {
		get: (ns) => ns === 'llm-pi-ai' ? { providers: { opencode: { models: [] } } } : undefined,
		mutate: async (ns, ops) => writes.push({ ns, ops }),
	};
	const fetchImpl = async () => ({ ok: true, json: async () => catalogWith({ 'dead-free': { cost: { input: 0, output: 0 }, status: 'deprecated' } }) });
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl });
	assert.equal(count, undefined);
	assert.equal(writes.length, 0);
});

test('refresh leaves the list untouched on a fetch failure', async () => {
	const writes = [];
	const settings = {
		get: (ns) => ns === 'llm-pi-ai' ? { providers: { opencode: { models: [] } } } : undefined,
		async mutate(ns, ops) { writes.push({ ns, ops }); },
	};
	const fetchImpl = async () => { throw new Error('network down'); };
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl });
	assert.equal(count, undefined);
	assert.equal(writes.length, 0);
});

test('refresh is bounded by the per-request deadline when a fetch hangs', async () => {
	const writes = [];
	const settings = {
		get: (ns) => ns === 'llm-pi-ai' ? { providers: { opencode: { models: [] } } } : undefined,
		async mutate(ns, ops) { writes.push({ ns, ops }); },
	};
	// A fetch that never settles would otherwise leave the refresh pending
	// forever; fetchJson must pass a combined signal that aborts on the
	// deadline, which this mock observes and turns into a rejection.
	const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
		init.signal.addEventListener('abort', () => reject(new Error('aborted')));
	});
	const started = Date.now();
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl, requestTimeoutMs: 100 });
	const elapsed = Date.now() - started;
	assert.equal(count, undefined);
	assert.equal(writes.length, 0);
	assert.ok(elapsed < 10000, `refresh took too long: ${elapsed}ms`);
});

test('refresh never writes while the llm-pi-ai namespace is unregistered', async () => {
	const writes = [];
	const settings = {
		get: (ns) => ns === 'llm-pi-ai' ? undefined : undefined,
		async mutate(ns, ops) { writes.push({ ns, ops }); },
	};
	const count = await refreshOpenCodeFreeModels({ settings, timeoutMs: 30 });
	assert.equal(count, undefined);
	assert.equal(writes.length, 0);
});

test('sameModelIds compares id sets regardless of order', () => {
	assert.equal(sameModelIds(['a', 'b'], ['b', 'a']), true);
	assert.equal(sameModelIds(['a'], ['a']), true);
	assert.equal(sameModelIds(['a'], ['a', 'b']), false);
	assert.equal(sameModelIds([], []), true);
});

test('configuredModelIds reads ids from a resolved value, tolerating gaps', () => {
	assert.deepEqual(configuredModelIds({ providers: { opencode: { models: [{ id: 'a' }, { id: 'b' }] } } }), ['a', 'b']);
	assert.equal(configuredModelIds({ providers: {} }), undefined);
	assert.equal(configuredModelIds({}), undefined);
	assert.equal(configuredModelIds({ providers: { opencode: {} } }), undefined);
	assert.equal(configuredModelIds({ providers: { opencode: { models: [{ id: 'a' }, {}] } } }), undefined);
});

test('refresh skips the write when the served set and routing already match', async () => {
	const writes = [];
	const settings = {
		get: (ns) => ns === 'llm-pi-ai' ? {
			providers: { opencode: {
				api: 'openai-completions',
				baseURL: 'https://opencode.ai/zen/v1',
				models: [{ id: 'hy3-free' }],
			} },
		} : undefined,
		async mutate(ns, ops) { writes.push({ ns, ops }); },
	};
	const fetchImpl = async () => ({ ok: true, json: async () => catalogWith({
		'hy3-free': { cost: { input: 0, output: 0 } },
		'paid': { cost: { input: 2, output: 12 } },
	}) });
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl });
	assert.equal(count, 1); // still reports the usable count
	assert.equal(writes.length, 0); // but nothing was written
});

test('refresh writes when a new free model appears', async () => {
	const writes = [];
	const settings = {
		get: (ns) => ns === 'llm-pi-ai' ? {
			providers: { opencode: {
				api: 'openai-completions',
				baseURL: 'https://opencode.ai/zen/v1',
				models: [{ id: 'old-model' }],
			} },
		} : undefined,
		async mutate(ns, ops) { writes.push({ ns, ops }); },
	};
	const fetchImpl = async () => ({ ok: true, json: async () => catalogWith({
		'old-model': { cost: { input: 0, output: 0 } },
		'brand-new-free': { cost: { input: 0, output: 0 } },
	}) });
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl });
	assert.equal(count, 2);
	assert.equal(writes.length, 1);
	assert.deepEqual(writes[0].ops[2].value, [{ id: 'brand-new-free' }, { id: 'old-model' }]);
});

test('mergeModelEntries preserves surviving model metadata', () => {
	const current = { providers: { opencode: { models: [{ id: 'kept', maxTokens: 1234 }, { id: 'old' }] } } };
	const merged = mergeModelEntries(current, [{ id: 'kept' }, { id: 'added' }]);
	assert.deepEqual(merged, [{ id: 'kept', maxTokens: 1234 }, { id: 'added' }]);
});

test('refresh moves the opencode default model when it is dropped', async () => {
	const writes = [];
	const saves = [];
	const settings = {
		get: (ns) => ns === 'llm-pi-ai' ? { providers: { opencode: { models: [{ id: 'big-pickle' }] } } } : undefined,
		async mutate(ns, ops) { writes.push({ ns, ops }); },
	};
	const defaultModel = {
		currentSelection: () => ({ provider: 'opencode', model: 'big-pickle' }),
		async saveSelection(next) { saves.push(next); },
	};
	const fetchImpl = async () => ({ ok: true, json: async () => catalogWith({
		'hy3-free': { cost: { input: 0, output: 0 } },
	}) });
	const count = await refreshOpenCodeFreeModels({ settings, defaultModel, fetchImpl });
	assert.equal(count, 1);
	assert.deepEqual(saves, [{ provider: 'opencode', model: 'hy3-free' }]);
});

test('refresh leaves a non-opencode default untouched', async () => {
	const writes = [];
	const saves = [];
	const settings = {
		get: (ns) => ns === 'llm-pi-ai' ? { providers: { opencode: { models: [{ id: 'big-pickle' }] } } } : undefined,
		async mutate(ns, ops) { writes.push({ ns, ops }); },
	};
	const defaultModel = {
		currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
		async saveSelection(next) { saves.push(next); },
	};
	const fetchImpl = async () => ({ ok: true, json: async () => catalogWith({
		'hy3-free': { cost: { input: 0, output: 0 } },
	}) });
	await refreshOpenCodeFreeModels({ settings, defaultModel, fetchImpl });
	assert.deepEqual(saves, []);
});
