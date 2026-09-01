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
const OPENCODE_ROUTE_BASE_URL = 'https://opencode.ai/zen/v1';
/**
 * The zen gateway serves one wire protocol per model, not one per gateway: a
 * model reached on the wrong endpoint answers 500 on every attempt. A pi-ai
 * route carries a single protocol (`PiAiModelProfile` has no per-model `api`),
 * so the free set is split across one route per protocol PawWork serves.
 *
 * `catalogProvider` is the models.dev `provider.npm` marker, which is what the
 * gateway's own endpoint table is keyed by: absent means `/chat/completions`
 * and `@ai-sdk/openai` means `/responses`. A free model marked for a protocol
 * no route claims (`@ai-sdk/anthropic`, `@ai-sdk/google`) is left out rather
 * than routed somewhere it cannot answer.
 */
const OPENCODE_ROUTES = [
	{ route: 'opencode', api: 'openai-completions', catalogProvider: undefined },
	{ route: 'opencode-responses', api: 'openai-responses', catalogProvider: '@ai-sdk/openai' },
];
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
 * Select the free, non-deprecated opencode models, split by the route that can
 * actually serve each one.
 * @param catalog - the raw `models.dev/api.json` document.
 * @returns `routes`, each route's selectable ids in sorted order and shaped as
 *   pi-ai model entries, plus `unroutable`, the free ids whose protocol no
 *   route claims.
 */
function selectFreeAndServed(catalog) {
	const routes = Object.fromEntries(OPENCODE_ROUTES.map(({ route }) => [route, []]));
	const unroutable = [];
	const models = catalog?.opencode?.models;
	if (models === null || typeof models !== 'object' || models === undefined) return { routes, unroutable };
	for (const [id, entry] of Object.entries(models)) {
		if (entry === null || typeof entry !== 'object') continue;
		if (entry.status === 'deprecated') continue;
		if (!isZeroCost(entry.cost)) continue;
		const target = OPENCODE_ROUTES.find(({ catalogProvider }) => catalogProvider === entry.provider?.npm);
		if (target === undefined) {
			unroutable.push(id);
			continue;
		}
		routes[target.route].push(modelProfile(id, entry));
	}
	for (const list of Object.values(routes)) list.sort((left, right) => left.id.localeCompare(right.id));
	return { routes, unroutable };
}
/**
 * Keep metadata models.dev cannot answer; its live catalog owns identity,
 * capacities, modalities, and selectable efforts for this product-managed
 * route. `compat` remains local because it describes this gateway's wire —
 * which is why it is only ever carried over within the same route: a switch
 * one protocol declares is refused by another.
 */
function mergeModelEntries(currentValue, route, selectable) {
	const current = currentValue?.providers?.[route]?.models;
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
 * model. Move to the first surviving selectable model, preferring the route the
 * retired default sat on so the replacement keeps its protocol. Only touches a
 * default on a route this refresh owns; a user default on another provider is
 * left alone.
 */
async function ensureDefaultModelSurvives({ defaultModel, logger, routes }) {
	if (defaultModel === undefined) return;
	let current;
	try {
		current = defaultModel.currentSelection();
	} catch {
		return; // default-model service unavailable; leave selection untouched
	}
	if (current === undefined || routes[current.provider] === undefined) return;
	if (routes[current.provider].some((entry) => entry.id === current.model)) return;
	const candidate = [current.provider, ...OPENCODE_ROUTES.map(({ route }) => route)]
		.map((route) => ({ route, entry: routes[route][0] }))
		.find(({ entry }) => entry !== undefined);
	if (candidate === undefined) return;
	const next = {
		provider: candidate.route,
		model: candidate.entry.id,
	};
	try {
		await defaultModel.saveSelection(next);
		logger?.info?.(`default opencode model ${current.model} retired; moved to ${candidate.entry.id}`);
	} catch (error) {
		logger?.warn?.(`failed to move default opencode model from ${current.model} to ${candidate.entry.id}: ${error instanceof Error ? error.message : String(error)}`);
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
 * untouched. A successful non-empty set replaces each route's models and pins
 * the gateway protocol and endpoint needed by IDs absent from the bundled
 * mixed-protocol catalog, which triggers the pi-ai adapter to rebuild. A route
 * the live catalog has nothing for keeps its packaged list rather than being
 * emptied, because an empty list means "serve the whole bundled catalog".
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
	const { routes, unroutable } = selectFreeAndServed(catalog);
	const total = Object.values(routes).reduce((count, list) => count + list.length, 0);
	if (total === 0) {
		logger?.warn?.('OpenCode Free catalog refresh found no usable free models; leaving the packaged model list');
		return undefined;
	}
	if (unroutable.length > 0) {
		logger?.warn?.(`OpenCode Free catalog refresh left out ${unroutable.join(', ')}: no PawWork route serves their protocol`);
	}
	// The network request may outlive a settings edit. Re-read the authoritative
	// descriptor immediately before deriving and committing the replacement,
	// then let the settings revision reject any still-later concurrent change.
	const descriptor = settings.describe?.().find((entry) => entry.ns === LLM_PI_AI_NAMESPACE);
	const currentValue = descriptor?.value ?? value;
	const merged = {};
	const ops = [];
	for (const { route, api } of OPENCODE_ROUTES) {
		const selectable = routes[route];
		// A route the live catalog has nothing for keeps whatever it is configured
		// with; writing `[]` would hand it the entire bundled catalog instead.
		merged[route] = selectable.length === 0
			? currentValue?.providers?.[route]?.models ?? []
			: mergeModelEntries(currentValue, route, selectable);
		if (selectable.length === 0) continue;
		const currentProvider = currentValue?.providers?.[route];
		// Skip the write when the live profiles and routing already match: a periodic
		// refresh must not churn settings.yaml or rebuild the adapter every interval.
		const unchanged = Array.isArray(currentProvider?.models)
			&& currentProvider?.api === api
			&& currentProvider?.baseURL === OPENCODE_ROUTE_BASE_URL
			&& isDeepStrictEqual(currentProvider.models, merged[route]);
		if (unchanged) continue;
		ops.push(
			{ op: 'set', path: ['providers', route, 'api'], value: api },
			{ op: 'set', path: ['providers', route, 'baseURL'], value: OPENCODE_ROUTE_BASE_URL },
			{ op: 'set', path: ['providers', route, 'models'], value: merged[route] },
		);
	}
	if (ops.length > 0) {
		await settings.mutate(LLM_PI_AI_NAMESPACE, ops, descriptor?.revision);
		logger?.info?.(`OpenCode Free catalog refreshed to ${total} models`);
	}
	// Keep the opencode default usable when the refresh drops it from the set.
	// Runs after (or without) a write, and also when the set is unchanged, so a
	// default pointing outside the configured list is repaired either way. The
	// merged lists are what the routes now serve, including a route this refresh
	// left alone.
	await ensureDefaultModelSurvives({ defaultModel, logger, routes: merged });
	return total;
}

module.exports = {
	OPENCODE_ROUTES,
	OPENCODE_ROUTE_BASE_URL,
	isZeroCost,
	refreshOpenCodeFreeModels,
	selectFreeAndServed,
	waitForNamespace,
};
