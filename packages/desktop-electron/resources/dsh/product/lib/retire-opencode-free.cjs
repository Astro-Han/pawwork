'use strict';

const LLM_PI_AI_NAMESPACE = 'llm-pi-ai';

/** The routes the retired free-tier refresher wrote into the user's settings. */
const RETIRED_ROUTES = ['opencode', 'opencode-responses'];

/**
 * Wait until the `llm-pi-ai` settings namespace is registered.
 *
 * DSH activates plugins by service availability, not patch order, so this
 * plugin may apply before `llm-pi-ai` has registered its section, and a
 * `settings.mutate` on an unregistered namespace throws.
 * @param get - the settings service's `get(ns)` (undefined while unregistered).
 * @param timeoutMs - upper bound on the wait.
 * @param signal - cancellation; aborts the wait promptly on shutdown.
 * @returns the resolved value, or `undefined` on timeout or cancel.
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
 * Delete the free-tier routes from the user's settings document.
 *
 * The product used to write these rows itself, into the user layer, where the
 * shipped patch cannot reach them. Removing the tier from the product therefore
 * does not remove them from an install that ran it: the routes still resolve,
 * their models stay in the picker, and every send fails at a gateway that no
 * longer serves them.
 *
 * Only the routes go. A selection left pointing at one is not repaired here,
 * because the replacement would be this plugin's guess rather than the user's
 * choice; with the route unregistered, the first-run model step asks them.
 * @param deps - settings service, optional logger, abort signal, wait bound.
 * @returns the routes removed, or `undefined` when nothing was written.
 */
async function retireOpenCodeFreeRoutes({ settings, logger, signal, timeoutMs }) {
	const value = await waitForNamespace((ns) => settings.get(ns), timeoutMs, signal);
	if (value === undefined) {
		logger?.warn?.('llm-pi-ai settings namespace is not registered; leaving any retired OpenCode Free routes in place');
		return undefined;
	}
	// Re-read immediately before deriving the ops so the revision matches what
	// is being edited.
	const descriptor = settings.describe?.().find((entry) => entry.ns === LLM_PI_AI_NAMESPACE);
	const providers = (descriptor?.value ?? value)?.providers;
	const retired = RETIRED_ROUTES.filter((route) => providers?.[route] !== undefined);
	if (retired.length === 0) return undefined;
	if (signal?.aborted) return undefined;
	await settings.mutate(
		LLM_PI_AI_NAMESPACE,
		retired.map((route) => ({ op: 'unset', path: ['providers', route] })),
		descriptor?.revision,
	);
	logger?.info?.(`removed the retired OpenCode Free routes: ${retired.join(', ')}`);
	return retired;
}

module.exports = { retireOpenCodeFreeRoutes, RETIRED_ROUTES, LLM_PI_AI_NAMESPACE };
