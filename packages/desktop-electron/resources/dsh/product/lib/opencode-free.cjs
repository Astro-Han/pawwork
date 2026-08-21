'use strict';
const { isDeepStrictEqual } = require('node:util');
/**
 * Refresh OpenCode Free membership and capabilities from models.dev without
 * taking ownership of streaming. The explicit route protocol is required for
 * new IDs because the bundled OpenCode catalog spans several protocols. Only
 * zero-cost, non-deprecated models are selected. Fetch, parse, and empty-result
 * failures leave the packaged fallback untouched because an empty configured
 * model list means "use the entire bundled catalog" in DSH.
 */

/** Live opencode catalog (what the opencode CLI itself reads). */
const OPENCODE_MODELS_URL = 'https://models.dev/api.json';
/** The settings namespace the pi-ai adapter owns. */
const LLM_PI_AI_NAMESPACE = 'llm-pi-ai';
/** Path of the opencode model list inside that namespace. */
const MODELS_PATH = ['providers', 'opencode', 'models'];
const OPENCODE_ROUTE_API = 'openai-completions';
const OPENCODE_ROUTE_BASE_URL = 'https://opencode.ai/zen/v1';
/** Capabilities the current pi-ai adapter can express. */
const SUPPORTED_INPUT_MODALITIES = new Set(['text', 'image']);
const SUPPORTED_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
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
/** Translate one models.dev entry into fields the pi-ai settings schema owns. */
function modelProfile(id, entry) {
	const profile = { id };
	if (typeof entry.name === 'string' && entry.name.length > 0) profile.name = entry.name;
	if (Number.isInteger(entry.limit?.context) && entry.limit.context > 0) profile.contextWindow = entry.limit.context;
	if (Number.isInteger(entry.limit?.output) && entry.limit.output > 0) profile.maxTokens = entry.limit.output;
	const input = Array.isArray(entry.modalities?.input)
		? entry.modalities.input.filter((modality) => SUPPORTED_INPUT_MODALITIES.has(modality))
		: [];
	if (input.length > 0) profile.input = [...new Set(input)];
	if (entry.reasoning === false) profile.reasoningEfforts = false;
	const reasoningEfforts = {};
	if (Array.isArray(entry.reasoning_options)) {
		if (entry.reasoning_options.some((option) => option?.type === 'toggle')) reasoningEfforts.off = null;
		for (const option of entry.reasoning_options) {
			if (option?.type !== 'effort' || !Array.isArray(option.values)) continue;
			for (const effort of option.values) {
				if (SUPPORTED_REASONING_EFFORTS.has(effort)) reasoningEfforts[effort] = effort;
			}
		}
	}
	// `reasoning: true` with no effort values means the provider may think, but
	// exposes no selectable level. Let it use its default instead of inventing
	// wire spellings the catalog did not advertise.
	if (entry.reasoning !== false && Object.keys(reasoningEfforts).some((effort) => effort !== 'off')) profile.reasoningEfforts = reasoningEfforts;
	return profile;
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
		out.push(modelProfile(id, entry));
	}
	return out.sort((left, right) => left.id.localeCompare(right.id));
}
/**
 * Keep metadata models.dev cannot answer; its live catalog owns identity,
 * capacities, modalities, and selectable efforts for this product-managed
 * route. `compat` remains local because it describes this gateway's wire.
 */
function mergeModelEntries(currentValue, selectable) {
	const current = currentValue?.providers?.opencode?.models;
	if (!Array.isArray(current)) return selectable;
	const existing = new Map(current.map((entry) => [entry?.id, entry]));
	return selectable.map((entry) => {
		const local = existing.get(entry.id);
		return {
			...local?.maxTokens === undefined ? {} : { maxTokens: local.maxTokens },
			...local?.compat === undefined ? {} : { compat: local.compat },
			...entry,
		};
	});
}
/**
 * Keep the opencode default model usable after a refresh drops it.
 *
 * The product ships `opencode/big-pickle` as the default; if the refresh stops
 * selecting it (upstream deprecation), new sessions would fail with an unknown
 * model. Move to the first surviving selectable model. Only touches an
 * `opencode` default; a user default on another provider is left alone.
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
	const fallback = selectable[0];
	if (fallback === undefined) return;
	const next = {
		provider: 'opencode',
		model: fallback.id,
	};
	try {
		await defaultModel.saveSelection(next);
		logger?.info?.(`default opencode model ${current.model} retired; moved to ${fallback.id}`);
	} catch (error) {
		logger?.warn?.(`failed to move default opencode model from ${current.model} to ${fallback.id}: ${error instanceof Error ? error.message : String(error)}`);
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
 * and pins the gateway protocol and endpoint needed by IDs absent from the
 * bundled mixed-protocol catalog, which triggers the pi-ai adapter to rebuild.
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
	// The network request may outlive a settings edit. Re-read the authoritative
	// descriptor immediately before deriving and committing the replacement,
	// then let the settings revision reject any still-later concurrent change.
	const descriptor = settings.describe?.().find((entry) => entry.ns === LLM_PI_AI_NAMESPACE);
	const currentValue = descriptor?.value ?? value;
	const nextIds = selectable.map((entry) => entry.id);
	const merged = mergeModelEntries(currentValue, selectable);
	const currentModels = currentValue?.providers?.opencode?.models;
	const currentProvider = currentValue?.providers?.opencode;
	// Skip the write when the live profiles and routing already match: a periodic
	// refresh must not churn settings.yaml or rebuild the adapter every interval.
	const unchanged = Array.isArray(currentModels)
		&& currentProvider?.api === OPENCODE_ROUTE_API
		&& currentProvider?.baseURL === OPENCODE_ROUTE_BASE_URL
		&& isDeepStrictEqual(currentModels, merged);
	if (!unchanged) {
		await settings.mutate(LLM_PI_AI_NAMESPACE, [
			{ op: 'set', path: ['providers', 'opencode', 'api'], value: OPENCODE_ROUTE_API },
			{ op: 'set', path: ['providers', 'opencode', 'baseURL'], value: OPENCODE_ROUTE_BASE_URL },
			{ op: 'set', path: MODELS_PATH, value: merged },
		], descriptor?.revision);
		logger?.info?.(`OpenCode Free catalog refreshed to ${selectable.length} models`);
	}
	// Keep the opencode default usable when the refresh drops it from the set.
	// Runs after (or without) a write, and also when the set is unchanged, so a
	// default pointing outside the configured list is repaired either way.
	await ensureDefaultModelSurvives({ defaultModel, logger, nextIds, selectable });
	return selectable.length;
}

module.exports = {
	isZeroCost,
	refreshOpenCodeFreeModels,
	selectFreeAndServed,
	waitForNamespace,
};
