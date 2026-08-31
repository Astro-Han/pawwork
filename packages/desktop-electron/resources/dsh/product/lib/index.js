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
const STARTUP_RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000];

// How the Electron main process learns the URL to load. It is the answer to a
// question DSH otherwise only answers in prose: `dsh web: <url>` is a startup
// notice addressed to a person — it grew a `(LAN: …)` suffix, its host comes
// from a constant the bundle keeps to itself, and it shares a prefix with the
// browser-handoff line beside it. Parsing it makes any upstream rewording a
// PawWork that cannot start, and routes the launch token through the stream
// that is mirrored into the persistent application log. The IPC channel the
// spawn already opens carries the same fact as data, addressed to us.
const WEB_READY_MESSAGE = 'pawwork:web-ready';

/**
 * Report the authenticated root URL once this process can serve it. The token
 * in that URL is the sole authentication input: loading the root with it mints
 * the session cookie every later request rides on, so the URL is the whole
 * handoff and an origin alone would answer 401.
 */
export function announceWebReady(ctx) {
	ctx.inject(['connection'], (readyCtx) => {
		const announce = () => {
			// Settling can retire either service; the URL needs both, and a
			// half-torn-down tree is a start that failed, not one to report.
			if (readyCtx.get('webServer') === undefined) return;
			if (readyCtx.get('connection') === undefined) return;
			const url = readyCtx.connection.authenticatedUrl(
				`http://127.0.0.1:${String(readyCtx.webServer.port)}`,
			);
			// A reload re-runs this; the parent keeps the first URL, and the
			// launch token outlives Connection reloads, so both name one session.
			if (process.connected) process.send({ type: WEB_READY_MESSAGE, url });
		};
		// The server binds before the tree finishes loading, so announcing on
		// injection alone would hand over a URL whose page is still missing
		// plugins. Wait for the loader exactly as the upstream URL line does.
		const settled = readyCtx.get('loader')?.await();
		if (settled === undefined) announce();
		else settled.then(announce, () => {});
	});
}

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

async function runStartupRefresh(ctx, controller, retryIndex = 0) {
	const refreshed = await runRefresh(ctx, controller);
	if (refreshed !== undefined || controller.signal.aborted) return;
	const delay = STARTUP_RETRY_DELAYS_MS[retryIndex];
	if (delay === undefined) return;
	ctx.setTimeout(
		() => void runStartupRefresh(ctx, controller, retryIndex + 1),
		delay,
	);
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
		subprocess: ctx.subprocess,
	});
	announceWebReady(ctx);
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
	// away. Retry transient startup failures twice before falling back to the
	// normal periodic sweep.
	void runStartupRefresh(ctx, controller);
	ctx.interval(() => runRefresh(ctx, controller), REFRESH_INTERVAL_MS);
	ctx.effect(() => () => controller.abort(new Error('PawWork product stopped')));
}
