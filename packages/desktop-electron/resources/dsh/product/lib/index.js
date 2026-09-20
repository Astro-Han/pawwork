import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDesktopHost, registerCommunityMarketRoutes } = require('./desktop-host.cjs');
const { retireOpenCodeFreeRoutes } = require('./retire-opencode-free.cjs');

export const name = "pawwork-product"

// `settings` is here for the free-tier cleanup below: this plugin wrote those
// rows, so it is the one that can take them back.
export const inject = ['settings', 'subprocess', 'webServer'];

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

	ctx.effect(() => {
		const controller = new AbortController();
		// A rejection here would surface as an unhandled rejection and take the
		// sidecar with it, and a stale route is not worth that.
		void retireOpenCodeFreeRoutes({
			settings: ctx.settings,
			logger: ctx.logger,
			signal: controller.signal,
		}).catch((error) => {
			ctx.logger?.warn?.(
				`could not remove the retired OpenCode Free routes: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		return () => controller.abort();
	});
}
