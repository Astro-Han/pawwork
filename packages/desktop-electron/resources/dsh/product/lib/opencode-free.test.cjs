'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const {
	isZeroCost,
	selectFreeAndServed,
	waitForNamespace,
	refreshOpenCodeFreeModels,
	sameModelIds,
	configuredModelIds,
} = require('./opencode-free.cjs');

// A catalog shaped like models.opencode.ai/api.json (opencode provider).
function catalogWith(models) {
	return { opencode: { api: 'https://opencode.ai/zen/v1', models } };
}

test('isZeroCost accepts only fully zero-cost models across all tiers', () => {
	assert.equal(isZeroCost({ input: 0, output: 0, cache_read: 0 }), true);
	assert.equal(isZeroCost({ input: 0, output: 0, cache_read: 0, cache_write: 0 }), true);
	assert.equal(isZeroCost([{ input: 0, output: 0 }]), true);
	// Any present billable field above zero makes the model paid.
	assert.equal(isZeroCost({ input: 0, output: 1 }), false);
	assert.equal(isZeroCost({ input: 0, cache_read: 1 }), false);
	assert.equal(isZeroCost({ input: 0, cache_write: 1 }), false);
	assert.equal(isZeroCost({ input: 2, output: 12 }), false);
	// A later paid tier still makes the whole model paid.
	assert.equal(isZeroCost([{ input: 0 }, { input: 1 }]), false);
	// Zero-like but non-numeric values are rejected, not coerced.
	assert.equal(isZeroCost({ input: null }), false);
	assert.equal(isZeroCost({ input: '' }), false);
	assert.equal(isZeroCost({ input: false }), false);
	assert.equal(isZeroCost({ input: NaN }), false);
	// Non-object inputs are rejected.
	assert.equal(isZeroCost(null), false);
	assert.equal(isZeroCost('0'), false);
	assert.equal(isZeroCost(undefined), false);
	assert.equal(isZeroCost([]), false);
});

test('selectFreeAndServed returns only free AND served models, sorted', () => {
	const catalog = catalogWith({
		'new-free': { cost: { input: 0, output: 0 } },
		'free-but-not-served': { cost: { input: 0, output: 0 } },
		'paid': { cost: { input: 2, output: 12 } },
		'free-persisted': { cost: { input: 0, output: 0 } },
	});
	const served = ['new-free', 'paid', 'free-persisted'];
	assert.deepEqual(selectFreeAndServed(catalog, served), [
		{ id: 'free-persisted' },
		{ id: 'new-free' },
	]);
});

test('selectFreeAndServed tolerates missing opencode / models / malformed entries', () => {
	assert.deepEqual(selectFreeAndServed({}, ['a']), []);
	assert.deepEqual(selectFreeAndServed({ opencode: {} }, ['a']), []);
	assert.deepEqual(selectFreeAndServed({ opencode: { models: { a: null } } }, ['a']), []);
	assert.deepEqual(selectFreeAndServed(null, []), []);
	assert.deepEqual(selectFreeAndServed(catalogWith({ a: { cost: { input: 0 } } }), []), []);
});

test('waitForNamespace resolves with the descriptor once registered', async () => {
	let registrations = [];
	const describe = () => registrations;
	const pending = waitForNamespace(describe, 5000);
	setTimeout(() => {
		registrations = [{ ns: 'llm-pi-ai', revision: 7 }];
	}, 30);
	const descriptor = await pending;
	assert.deepEqual(descriptor, { ns: 'llm-pi-ai', revision: 7 });
});

test('waitForNamespace times out without a registered namespace', async () => {
	const descriptor = await waitForNamespace(() => [], 50);
	assert.equal(descriptor, undefined);
});

test('waitForNamespace aborts promptly when the signal fires', async () => {
	const controller = new AbortController();
	const pending = waitForNamespace(() => [], 5000, controller.signal);
	setTimeout(() => controller.abort(), 30);
	const descriptor = await pending;
	assert.equal(descriptor, undefined);
});

test('refresh writes the free-and-served intersection via settings.mutate', async () => {
	const writes = [];
	const settings = {
		describe: () => [{ ns: 'llm-pi-ai', revision: 3 }],
		async mutate(ns, ops, revision) {
			writes.push({ ns, ops, revision });
		},
	};
	const fetchImpl = async (url) => {
		if (url.includes('models.opencode.ai')) {
			return {
				ok: true,
				json: async () => catalogWith({
					'hy3-free': { cost: { input: 0, output: 0 } },
					'ghost-free': { cost: { input: 0, output: 0 } }, // not served -> excluded
					'paid': { cost: { input: 2, output: 12 } },
				}),
			};
		}
		// /zen/v1/models
		return {
			ok: true,
			json: async () => ({ data: [{ id: 'hy3-free' }, { id: 'paid' }] }),
		};
	};
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl, describe: settings.describe });
	assert.equal(count, 1);
	assert.equal(writes.length, 1);
	assert.equal(writes[0].ns, 'llm-pi-ai');
	assert.deepEqual(writes[0].ops, [
		{ op: 'set', path: ['providers', 'opencode', 'models'], value: [{ id: 'hy3-free' }] },
	]);
	assert.equal(writes[0].revision, 3);
});

test('refresh does not write an empty list when nothing is usable', async () => {
	const writes = [];
	const settings = {
		describe: () => [{ ns: 'llm-pi-ai', revision: 1 }],
		mutate: async (ns, ops) => writes.push({ ns, ops }),
	};
	const fetchImpl = async (url) => {
		if (url.includes('models.opencode.ai')) {
			return { ok: true, json: async () => catalogWith({ 'free-not-served': { cost: { input: 0, output: 0 } } }) };
		}
		return { ok: true, json: async () => ({ data: [] }) };
	};
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl, describe: settings.describe });
	assert.equal(count, undefined);
	assert.equal(writes.length, 0);
});

test('refresh leaves the list untouched on a fetch failure', async () => {
	const writes = [];
	const settings = {
		describe: () => [{ ns: 'llm-pi-ai', revision: 1 }],
		async mutate(ns, ops) { writes.push({ ns, ops }); },
	};
	const fetchImpl = async () => { throw new Error('network down'); };
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl, describe: settings.describe });
	assert.equal(count, undefined);
	assert.equal(writes.length, 0);
});

test('refresh is bounded by the per-request deadline when a fetch hangs', async () => {
	const writes = [];
	const settings = {
		describe: () => [{ ns: 'llm-pi-ai', revision: 1 }],
		async mutate(ns, ops) { writes.push({ ns, ops }); },
	};
	// A fetch that never settles would otherwise leave the refresh pending
	// forever; fetchJson must pass a combined signal that aborts on the
	// deadline, which this mock observes and turns into a rejection.
	const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
		init.signal.addEventListener('abort', () => reject(new Error('aborted')));
	});
	const started = Date.now();
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl, describe: settings.describe, requestTimeoutMs: 100 });
	const elapsed = Date.now() - started;
	assert.equal(count, undefined);
	assert.equal(writes.length, 0);
	assert.ok(elapsed < 10000, `refresh took too long: ${elapsed}ms`);
});

test('refresh never writes while the llm-pi-ai namespace is unregistered', async () => {
	const writes = [];
	const settings = {
		describe: () => [],
		async mutate(ns, ops) { writes.push({ ns, ops }); },
	};
	const count = await refreshOpenCodeFreeModels({ settings, describe: settings.describe, timeoutMs: 30 });
	assert.equal(count, undefined);
	assert.equal(writes.length, 0);
});

test('sameModelIds compares id sets regardless of order', () => {
	assert.equal(sameModelIds(['a', 'b'], ['b', 'a']), true);
	assert.equal(sameModelIds(['a'], ['a']), true);
	assert.equal(sameModelIds(['a'], ['a', 'b']), false);
	assert.equal(sameModelIds([], []), true);
});

test('configuredModelIds reads ids from a resolved descriptor, tolerating gaps', () => {
	assert.deepEqual(configuredModelIds({ value: { providers: { opencode: { models: [{ id: 'a' }, { id: 'b' }] } } } }), ['a', 'b']);
	assert.equal(configuredModelIds({ value: {} }), undefined);
	assert.equal(configuredModelIds({}), undefined);
	assert.equal(configuredModelIds({ value: { providers: { opencode: {} } } }), undefined);
	assert.equal(configuredModelIds({ value: { providers: { opencode: { models: [{ id: 'a' }, {}] } } } }), undefined);
});

test('refresh skips the write when the served set already matches', async () => {
	const writes = [];
	const settings = {
		describe: () => [{
			ns: 'llm-pi-ai',
			revision: 5,
			value: { providers: { opencode: { models: [{ id: 'hy3-free' }] } } },
		}],
		async mutate(ns, ops) { writes.push({ ns, ops }); },
	};
	const fetchImpl = async (url) => {
		if (url.includes('models.opencode.ai')) {
			return { ok: true, json: async () => catalogWith({
				'hy3-free': { cost: { input: 0, output: 0 } },
				'paid': { cost: { input: 2, output: 12 } },
			}) };
		}
		return { ok: true, json: async () => ({ data: [{ id: 'hy3-free' }, { id: 'paid' }] }) };
	};
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl, describe: settings.describe });
	assert.equal(count, 1); // still reports the usable count
	assert.equal(writes.length, 0); // but nothing was written
});

test('refresh writes when a new free-and-served model appears', async () => {
	const writes = [];
	const settings = {
		describe: () => [{
			ns: 'llm-pi-ai',
			revision: 5,
			value: { providers: { opencode: { models: [{ id: 'old-model' }] } } },
		}],
		async mutate(ns, ops) { writes.push({ ns, ops }); },
	};
	const fetchImpl = async (url) => {
		if (url.includes('models.opencode.ai')) {
			return { ok: true, json: async () => catalogWith({
				'old-model': { cost: { input: 0, output: 0 } },
				'brand-new-free': { cost: { input: 0, output: 0 } },
			}) };
		}
		return { ok: true, json: async () => ({ data: [{ id: 'old-model' }, { id: 'brand-new-free' }] }) };
	};
	const count = await refreshOpenCodeFreeModels({ settings, fetchImpl, describe: settings.describe });
	assert.equal(count, 2);
	assert.equal(writes.length, 1);
	assert.deepEqual(writes[0].ops[0].value, [{ id: 'brand-new-free' }, { id: 'old-model' }]);
});
