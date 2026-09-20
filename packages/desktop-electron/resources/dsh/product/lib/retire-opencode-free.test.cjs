'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { retireOpenCodeFreeRoutes } = require('./retire-opencode-free.cjs');

function settingsDouble(providers, { revision = 7 } = {}) {
	const mutations = [];
	return {
		mutations,
		service: {
			get: () => ({ providers }),
			describe: () => [{ ns: 'llm-pi-ai', value: { providers }, revision }],
			mutate: async (ns, ops, expectedRevision) => {
				mutations.push({ ns, ops, expectedRevision });
			},
		},
	};
}

test('removes only the routes the retired refresher wrote', async () => {
	const { service, mutations } = settingsDouble({
		opencode: { api: 'openai-completions' },
		'opencode-responses': { api: 'openai-responses' },
		'opencode-go': { apiKeyEnv: 'OPENCODE_API_KEY' },
		deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
	});

	assert.deepEqual(await retireOpenCodeFreeRoutes({ settings: service }), ['opencode', 'opencode-responses']);
	assert.equal(mutations.length, 1);
	assert.equal(mutations[0].ns, 'llm-pi-ai');
	assert.equal(mutations[0].expectedRevision, 7);
	assert.deepEqual(mutations[0].ops, [
		{ op: 'unset', path: ['providers', 'opencode'] },
		{ op: 'unset', path: ['providers', 'opencode-responses'] },
	]);
});

test('writes nothing when the routes are already gone', async () => {
	const { service, mutations } = settingsDouble({ 'opencode-go': { apiKeyEnv: 'OPENCODE_API_KEY' } });

	assert.equal(await retireOpenCodeFreeRoutes({ settings: service }), undefined);
	assert.equal(mutations.length, 0);
});

test('leaves the routes alone when the namespace never registers', async () => {
	const mutations = [];
	const warnings = [];
	const settings = {
		get: () => undefined,
		describe: () => [],
		mutate: async (...args) => { mutations.push(args); },
	};

	assert.equal(
		await retireOpenCodeFreeRoutes({ settings, logger: { warn: (m) => warnings.push(m) }, timeoutMs: 0 }),
		undefined,
	);
	assert.equal(mutations.length, 0);
	assert.equal(warnings.length, 1);
});

test('does not write after the signal aborts', async () => {
	const { service, mutations } = settingsDouble({ opencode: { api: 'openai-completions' } });
	const controller = new AbortController();
	controller.abort();

	assert.equal(await retireOpenCodeFreeRoutes({ settings: service, signal: controller.signal }), undefined);
	assert.equal(mutations.length, 0);
});

test('touches no other namespace than llm-pi-ai', async () => {
	// The selection is deliberately not repaired here: the replacement would be
	// this plugin's guess rather than the user's choice.
	const { service, mutations } = settingsDouble({ opencode: { api: 'openai-completions' } });

	await retireOpenCodeFreeRoutes({ settings: service });
	assert.deepEqual([...new Set(mutations.map((entry) => entry.ns))], ['llm-pi-ai']);
});
