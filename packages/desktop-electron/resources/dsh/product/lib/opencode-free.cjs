'use strict';
/**
 * OpenCode Free catalog discovery for PawWork.
 *
 * The shipped "OpenCode Free" model list is a build-time static snapshot (the
 * product patch replaces `llm-pi-ai.providers.opencode.models` with a fixed
 * set of ids). Upstream opencode adds and retires free models independently of
 * any PawWork release, so a frozen list both hides new models and keeps dead
 * ones selectable until a request 401s, which the surface mislabels as
 * "API key is invalid".
 *
 * This module restores the old v1 behavior at runtime: it reads the live
 * models.dev catalog once, selects the models that are genuinely free and not
 * deprecated, and writes them into the existing `llm-pi-ai` settings
 * namespace. The `llm-pi-ai` adapter rebuilds from its configured model list
 * on change, so streaming stays with the already-verified pi-ai adapter; this
 * module only supplies the list.
 *
 * One authority, one predicate:
 *  - `models.dev/api.json` is the pricing/metadata authority (what opencode
 *    itself reads). A model is selectable iff its cost has no nonzero numeric
 *    leaf and it is not marked `deprecated`; the gateway serves a model that
 *    is neither paid nor deprecated, so no separate serviceability probe is
 *    needed. (A model priced at zero but `deprecated` — e.g. a promotion that
 *    has ended — 401s on use and must not be offered as free.)
 *
 * Route wiring: opencode speaks `openai-completions` at
 * `https://opencode.ai/zen/v1`. The adapter only accepts models it describes,
 * plus a route-level `api`/`baseURL` for the rest; the write therefore sets
 * those two keys alongside the model list so the selectable set is servable.
 *
 * Failure policy: any fetch/parse error, or a usable set of zero models,
 * leaves the configured list untouched (the packaged bootstrap) rather than
 * writing an empty list — DSH interprets an empty configured `models` as "use
 * the entire bundled catalog".
 */

/** Live opencode catalog (what the opencode CLI itself reads). */
const OPENCODE_MODELS_URL = 'https://models.dev/api.json';
/** The settings namespace the pi-ai adapter owns. */
const LLM_PI_AI_NAMESPACE = 'llm-pi-ai';
/** Path of the opencode model list inside that namespace. */
const MODELS_PATH = ['providers', 'opencode', 'models'];
/** Wire protocol every opencode route uses. */
const OPENCODE_ROUTE_API = 'openai-completions';
/** Base URL the opencode zen gateway serves. */
const OPENCODE_ROUTE_BASE_URL = 'https://opencode.ai/zen/v1';
/** The id the product ships as the default opencode model. */
const DEFAULT_OPENCODE_MODEL_ID = 'big-pickle';

/** The ids currently configured for opencode, when the resolved value lists them. */
function configuredModelIds(value) {
	const models = value?.providers?.opencode?.models;
	if (!Array.isArray(models)) return undefined;
	const ids = models.map((entry) => entry?.id).filter((id) => typeof id === 'string');
	return ids.length === models.length ? ids : undefined;
}
/** Whether the opencode route already carries our api/baseURL wiring. */
function routeConfigured(value) {
	const provider = value?.providers?.opencode;
	return provider?.api === OPENCODE_ROUTE_API && provider?.baseURL === OPENCODE_ROUTE_BASE_URL;
}
/** Whether two id arrays name the same set, in any order. */
function sameModelIds(left, right) {
	if (left.length !== right.length) return false;
	const a = new Set(left);
	return right.every((id) => a.has(id));
}
/**
 * A model is free only when its cost metadata has no nonzero numeric leaf.
 *
 * Fail-closed: a missing or non-object cost, or a missing `input`/`output`
 * (the schema's required pricing fields), is NOT free. The `tier` key is
 * structural metadata (a context-size threshold), not a billable field, so it
 * is ignored. This covers `cost.tiers[]`, `context_over_200k`, reasoning and
 * audio fields and any future nested pricing without enumerating them.
 */
function isZeroCost(cost) {
	if (cost === null || typeof cost !== 'object') return false;
	if (typeof cost.input !== 'number' || typeof cost.output !== 'number') return false;
	const walk = (node, key) => {
		if (key === 'tier') return true; // structural metadata, not billable
		if (typeof node === 'number') return node === 0;
		if (node === null || typeof node !== 'object') return true; // structural leaves are not prices
		return Object.entries(node).every(([childKey, child]) => walk(child, childKey));
	};
	return Object.keys(cost).length > 0 && walk(cost, 'root');
}
/**
 * Select the free, non-deprecated opencode models.
 * @param catalog - the raw `models.dev/api.json` document.
 * @returns the selectable ids in sorted order, each shaped as a pi-ai model entry.
 */
function selectFreeAndServed(catalog) {
	const opencode = catalog?.opencode;
	if (opencode === null || typeof opencode !== 'object') return [];
	const models = opencode.models;
	if (models === null || typeof models !== 'object') return [];
	const out = [];
	for (const [id, entry] of Object.entries(models)) {
		if (entry === null || typeof entry !== 'object') continue;
		if (entry.status === 'deprecated') continue;
		if (!isZeroCost(entry.cost)) continue;
		out.push({ id });
	}
	return out.sort((left, right) => left.id.localeCompare(right.id));
}
/** Preserve configured metadata for surviving models; new ids get `{ id }`. */
function mergeModelEntries(currentValue, selectable) {
	const current = currentValue?.providers?.opencode?.models;
	if (!Array.isArray(current)) return selectable;
	const existing = new Map(current.map((entry) => [entry?.id, entry]));
	return selectable.map((entry) => existing.get(entry.id) ?? entry);
}
/**
 * Keep the opencode default model usable after a refresh drops it.
 *
 * The product ships `opencode/big-pickle` as the default; if the refresh stops
 * selecting it (upstream deprecation), new sessions would fail with an unknown
 * model. Prefer the product default when it still survives, else the first
 * selectable id. Only touches an `opencode` default; a user default on another
 * provider is left alone.
 */
async function ensureDefaultModelSurvives({ defaultModel, logger, nextIds, selectable }) {
	if (defaultModel === undefined) return;
	let current;
	try {
		current = defaultModel.currentSelection();
	} catch {
		return; // default-model service unavailable; leave selection untouched
	}
	if (current === undefined || current.provider !== 'opencode') return;
	if (nextIds.includes(current.model)) return;
	const fallbackId = selectable.some((entry) => entry.id === DEFAULT_OPENCODE_MODEL_ID)
		? DEFAULT_OPENCODE_MODEL_ID
		: selectable[0]?.id;
	if (fallbackId === undefined) return;
	try {
		await defaultModel.saveSelection({ provider: 'opencode', model: fallbackId });
		logger?.info?.(`default opencode model ${current.model} retired; moved to ${fallbackId}`);
	} catch (error) {
		logger?.warn?.(`failed to move default opencode model from ${current.model} to ${fallbackId}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/** Per-request bound so a hung gateway cannot leave a refresh pending forever. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
/** Fetch one URL as JSON, honoring cancellation and a bounded deadline. */
async function fetchJson(url, fetchImpl, signal, requestTimeoutMs) {
	const deadline = AbortSignal.timeout(requestTimeoutMs);
	const requestSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
	const response = await fetchImpl(url, {
		headers: { accept: 'application/json' },
		signal: requestSignal,
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
 * plugin may apply before `llm-pi-ai` has registered its section; a
 * `settings.mutate` on an unregistered namespace throws. Bounded wait keeps a
 * slow adapter from silently dropping the refresh.
 * @param get - the settings service's `get(ns)` (resolved value, undefined while unregistered).
 * @param timeoutMs - upper bound on the wait.
 * @param signal - cancellation; aborts the wait promptly on shutdown.
 * @returns the resolved `llm-pi-ai` value, or `undefined` on timeout/cancel.
 */
async function waitForNamespace(get, timeoutMs, signal) {
	const deadline = Date.now() + (timeoutMs === undefined ? 10000 : timeoutMs);
	for (;;) {
		if (signal?.aborted) return undefined;
		const value = get(LLM_PI_AI_NAMESPACE);
		if (value !== undefined) return value;
		if (Date.now() >= deadline) return undefined;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}
/**
 * Refresh the OpenCode Free model list in the `llm-pi-ai` settings namespace.
 *
 * A fetch/parse failure or an empty usable set leaves the packaged list
 * untouched. A successful non-empty set replaces `providers.opencode.models`
 * (plus the route `api`/`baseURL` needed to serve models the bundled catalog
 * does not yet describe), which triggers the pi-ai adapter to rebuild.
 * Surviving models keep their configured metadata; when the opencode default
 * model is dropped, the default selection moves to a surviving model.
 * @param deps - settings service, optional default-model service, fetch impl, logger, abort signal.
 * @returns the selectable model count written, or `undefined` when nothing was written.
 */
async function refreshOpenCodeFreeModels({ settings, defaultModel, logger, fetchImpl = globalThis.fetch, signal, timeoutMs, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
	const value = await waitForNamespace((ns) => settings.get(ns), timeoutMs, signal);
	if (value === undefined) {
		logger?.warn?.('llm-pi-ai settings namespace is not registered; leaving the packaged OpenCode Free model list');
		return undefined;
	}
	let catalog;
	try {
		catalog = await fetchJson(OPENCODE_MODELS_URL, fetchImpl, signal, requestTimeoutMs);
	} catch (error) {
		logger?.warn?.(`OpenCode Free catalog refresh failed; leaving the packaged model list: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	const selectable = selectFreeAndServed(catalog);
	if (selectable.length === 0) {
		logger?.warn?.('OpenCode Free catalog refresh found no usable free models; leaving the packaged model list');
		return undefined;
	}
	const nextIds = selectable.map((entry) => entry.id);
	const currentIds = configuredModelIds(value);
	// Skip the write when the served set and routing already match: a periodic
	// refresh must not churn settings.yaml or rebuild the adapter every interval.
	if (currentIds !== undefined && routeConfigured(value) && sameModelIds(currentIds, nextIds)) return selectable.length;
	// Keep the opencode default usable when the refresh drops it from the set.
	await ensureDefaultModelSurvives({ defaultModel, logger, nextIds, selectable });
	const merged = mergeModelEntries(value, selectable);
	await settings.mutate(LLM_PI_AI_NAMESPACE, [
		{ op: 'set', path: ['providers', 'opencode', 'api'], value: OPENCODE_ROUTE_API },
		{ op: 'set', path: ['providers', 'opencode', 'baseURL'], value: OPENCODE_ROUTE_BASE_URL },
		{ op: 'set', path: MODELS_PATH, value: merged },
	]);
	logger?.info?.(`OpenCode Free catalog refreshed to ${selectable.length} models`);
	return selectable.length;
}

module.exports = {
	LLM_PI_AI_NAMESPACE,
	OPENCODE_MODELS_URL,
	OPENCODE_ROUTE_API,
	OPENCODE_ROUTE_BASE_URL,
	configuredModelIds,
	isZeroCost,
	mergeModelEntries,
	refreshOpenCodeFreeModels,
	sameModelIds,
	selectFreeAndServed,
	waitForNamespace,
};
