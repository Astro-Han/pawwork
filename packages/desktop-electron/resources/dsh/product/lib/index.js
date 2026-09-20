import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDesktopHost, registerCommunityMarketRoutes } = require('./desktop-host.cjs');

export const name = "pawwork-product"

export const inject = ['subprocess', 'webServer'];

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
}
