'use strict';
/**
 * OpenCode Free catalog discovery for PawWork.
 *
 * The shipped "OpenCode Free" model list is a build-time static snapshot (the
 * product patch replaces `llm-pi-ai.providers.opencode.models` with exactly
 * seven ids). Upstream opencode adds and retires free models independently of
 * any PawWork release, so a frozen list both hides new models and keeps dead
 * ones selectable until a 401 surfaces as "API key is invalid".
 *
 * This module restores the old v1 behavior at runtime: it reads the live
 * opencode catalog for pricing and the gateway's own model listing for
 * serviceability, then writes the intersection into the existing `llm-pi-ai`
 * settings namespace. The `llm-pi-ai` adapter rebuilds from its configured
 * model list on change, so streaming stays with the already-verified pi-ai
 * adapter; this module only supplies the list.
 *
 * Two authorities, one selectable set:
 *  - `models.opencode.ai/api.json` is the pricing/metadata authority.
 *  - `GET /zen/v1/models` (public credential) is the serviceability authority.
 *    A model that only exists in the metadata catalog — or one the gateway no
 *    longer serves — must not be offered as free.
 *
 * Failure policy: any fetch/parse error, or an intersection of zero usable
 * models, leaves the configured list untouched (the packaged seven-model
 * bootstrap) rather than writing an empty list — DSH interprets an empty
 * configured `models` as "use the entire bundled catalog".
 */

const path = require('node:path');

/** Live opencode catalog (what the opencode CLI itself reads). */
const OPENCODE_MODELS_URL = 'https://models.opencode.ai/api.json';
/** Gateway model listing under the public credential. */
const OPENCODE_ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';
/** The settings namespace the pi-ai adapter owns. */
const LLM_PI_AI_NAMESPACE = 'llm-pi-ai';
/** Path of the opencode model list inside that namespace. */
const MODELS_PATH = ['providers', 'opencode', 'models'];
/** The ids currently configured for opencode, when the descriptor resolves them. */
function configuredModelIds(descriptor) {
	const models = descriptor?.value?.providers?.opencode?.models;
	if (!Array.isArray(models)) return undefined;
	const ids = models.map((entry) => entry?.id).filter((id) => typeof id === 'string');
	return ids.length === models.length ? ids : undefined;
}
/** Whether two id arrays name the same set, in any order. */
function sameModelIds(left, right) {
	if (left.length !== right.length) return false;
	const a = new Set(left);
	return right.every((id) => a.has(id));
}
/** A model entry is free when its leading input cost is explicitly zero. */
function isZeroCost(cost) {
	if (cost === null || typeof cost !== 'object') return false;
	if (Array.isArray(cost)) return cost.length > 0 && isZeroCost(cost[0]);
	return Number(cost.input) === 0;
}
/**
 * Select the free-and-served opencode models.
 * @param catalog - the raw `models.opencode.ai/api.json` document.
 * @param servedIds - model ids served by `GET /zen/v1/models`.
 * @returns the selectable ids in sorted order, each shaped as a pi-ai model entry.
 */
function selectFreeAndServed(catalog, servedIds) {
	const opencode = catalog?.opencode;
	if (opencode === null || typeof opencode !== 'object') return [];
	const models = opencode.models;
	if (models === null || typeof models !== 'object') return [];
	const served = new Set(servedIds);
	const out = [];
	for (const [id, entry] of Object.entries(models)) {
		if (entry === null || typeof entry !== 'object') continue;
		if (!isZeroCost(entry.cost)) continue;
		if (!served.has(id)) continue;
		out.push({ id });
	}
	return out.sort((left, right) => left.id.localeCompare(right.id));
}
/** Fetch one URL as JSON, honoring cancellation. */
async function fetchJson(url, fetchImpl, signal) {
	const response = await fetchImpl(url, {
		headers: { accept: 'application/json' },
		...(signal === undefined ? {} : { signal }),
	});
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	const body = await response.json();
	if (body === null || typeof body !== 'object') throw new Error(`${url} did not answer with an object`);
	return body;
}
/**
 * Wait until the `llm-pi-ai` settings namespace is registered.
 *
 * DSH activates plugins by service availability, not patch order, so this
 * plugin may apply before `llm-pi-ai` has run `installSettingsSection`; a
 * `settings.mutate` on an unregistered namespace throws. Bounded wait keeps a
 * slow adapter from silently dropping the refresh.
 * @param describe - the settings service's `describe()`.
 * @param timeoutMs - upper bound on the wait.
 * @returns the `llm-pi-ai` descriptor, or `undefined` on timeout.
 */
async function waitForNamespace(describe, timeoutMs) {
	const deadline = Date.now() + (timeoutMs === undefined ? 10000 : timeoutMs);
	for (;;) {
		const descriptor = describe().find((entry) => entry.ns === LLM_PI_AI_NAMESPACE);
		if (descriptor !== undefined) return descriptor;
		if (Date.now() >= deadline) return undefined;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}
/**
 * Refresh the OpenCode Free model list in the `llm-pi-ai` settings namespace.
 *
 * A fetch or parse failure, or an empty usable set, leaves the packaged list
 * untouched. A successful non-empty set replaces `providers.opencode.models`,
 * which triggers the pi-ai adapter to rebuild on the next request.
 * @param deps - settings service, fetch impl, logger, and an optional abort signal.
 * @returns the selectable model count written, or `undefined` when nothing was written.
 */
async function refreshOpenCodeFreeModels({ settings, describe, logger, fetchImpl = globalThis.fetch, signal, timeoutMs }) {
	const descriptor = await waitForNamespace(describe ?? (() => settings.describe()), timeoutMs);
	if (descriptor === undefined) {
		logger?.warn?.('llm-pi-ai settings namespace is not registered; leaving the packaged OpenCode Free model list');
		return undefined;
	}
	let catalog;
	let gateway;
	try {
		[catalog, gateway] = await Promise.all([
			fetchJson(OPENCODE_MODELS_URL, fetchImpl, signal),
			fetchJson(OPENCODE_ZEN_MODELS_URL, fetchImpl, signal),
		]);
	} catch (error) {
		logger?.warn?.(`OpenCode Free catalog refresh failed; leaving the packaged model list: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	const servedIds = Array.isArray(gateway?.data) ? gateway.data.map((entry) => entry?.id).filter(Boolean) : [];
	const selectable = selectFreeAndServed(catalog, servedIds);
	if (selectable.length === 0) {
		logger?.warn?.('OpenCode Free catalog refresh found no usable free models; leaving the packaged model list');
		return undefined;
	}
	const nextIds = selectable.map((entry) => entry.id);
	const currentIds = configuredModelIds(descriptor);
	// Skip the write when the served set already matches: a periodic refresh
	// must not churn settings.yaml or rebuild the adapter every interval.
	if (currentIds !== undefined && sameModelIds(currentIds, nextIds)) return selectable.length;
	await settings.mutate(LLM_PI_AI_NAMESPACE, [{ op: 'set', path: MODELS_PATH, value: selectable }], descriptor.revision);
	logger?.info?.(`OpenCode Free catalog refreshed to ${selectable.length} models`);
	return selectable.length;
}

module.exports = {
	LLM_PI_AI_NAMESPACE,
	OPENCODE_MODELS_URL,
	OPENCODE_ZEN_MODELS_URL,
	configuredModelIds,
	isZeroCost,
	refreshOpenCodeFreeModels,
	sameModelIds,
	selectFreeAndServed,
	waitForNamespace,
};
