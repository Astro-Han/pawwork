import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { refreshOpenCodeFreeModels } = require('./opencode-free.cjs');

export const name = "pawwork-product"

// Requires the settings service (to refresh the llm-pi-ai model list) and the
// timer service (to re-run that refresh periodically). Activation waits for
// both, so the first refresh runs after the pi-ai adapter has registered its
// settings namespace rather than racing it.
export const inject = ['settings', 'timer'];

// How often to re-discover the OpenCode Free catalog. New free models appear
// without a PawWork release; the cadence balances freshness against the two
// cheap GETs per sweep and the (no-op when unchanged) settings write.
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

function runRefresh(ctx, controller) {
	return refreshOpenCodeFreeModels({
		settings: ctx.settings,
		describe: () => ctx.settings.describe(),
		logger: ctx.logger,
		signal: controller.signal,
	}).catch((error) => {
		// A refresh failure must not take the backend down; the packaged model
		// list stays and the next sweep retries.
		ctx.logger.warn?.(
			`OpenCode Free catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
}

export function apply(ctx) {
	const controller = new AbortController();
	// Immediate refresh so a fresh launch picks up the current catalog right
	// away, then periodic sweeps to follow upstream as it changes.
	void runRefresh(ctx, controller);
	ctx.interval(() => runRefresh(ctx, controller), REFRESH_INTERVAL_MS);
	ctx.effect(() => () => controller.abort(new Error('PawWork product stopped')));
}
