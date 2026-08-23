import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { refreshOpenCodeFreeModels } = require('./opencode-free.cjs');
const { createDesktopHost, registerCommunityMarketRoutes } = require('./desktop-host.cjs');

export const name = "pawwork-product"

// Requires the settings service (to refresh the llm-pi-ai model list), the
// timer service (to re-run that refresh periodically), and the default-model
// service (so a refresh that retires the opencode default can move it to a
// surviving model). Activation waits for all three.
export const inject = ['settings', 'timer', 'agentDefaultModel', 'subprocess', 'webServer'];

// How often to re-discover the OpenCode Free catalog. New free models appear
// without a PawWork release; the cadence balances freshness against the one
// cheap GET per sweep and the (no-op when unchanged) settings write.
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

function runRefresh(ctx, controller) {
	return refreshOpenCodeFreeModels({
		settings: ctx.settings,
		defaultModel: ctx.agentDefaultModel,
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
	const requiredEnvironment = (name) => {
		const value = process.env[name];
		if (!value) throw new Error(`PawWork Desktop host requires ${name}`);
		return value;
	};
	const desktopHost = createDesktopHost({
		dshBin: requiredEnvironment('PAWWORK_DSH_BIN'),
		home: requiredEnvironment('DSH_HOME'),
		nodeExecutable: requiredEnvironment('PAWWORK_NODE_EXECUTABLE'),
		profileDir: requiredEnvironment('PAWWORK_DSH_PROFILE_DIR'),
		subprocess: ctx.subprocess,
	});
	ctx.provide('desktopProfiles', desktopHost.desktopProfiles);
	ctx.provide('desktopPnpm', desktopHost.desktopPnpm);
	ctx.effect(() => {
		const unregister = registerCommunityMarketRoutes(
			ctx.webServer,
			desktopHost.communityMarket,
			requiredEnvironment('PAWWORK_HOST_TOKEN'),
		);
		return async () => {
			unregister();
			await desktopHost.dispose();
		};
	});

	const controller = new AbortController();
	// Immediate refresh so a fresh launch picks up the current catalog right
	// away, then periodic sweeps to follow upstream as it changes.
	void runRefresh(ctx, controller);
	ctx.interval(() => runRefresh(ctx, controller), REFRESH_INTERVAL_MS);
	ctx.effect(() => () => controller.abort(new Error('PawWork product stopped')));
}
