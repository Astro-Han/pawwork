const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * A context that behaves the way the harness does at the two moments this cares
 * about: injection, when the Web server has bound but the tree is still
 * loading, and settlement, when it has finished or torn something down.
 */
function stubContext({ port = 43123, retire = [], settle = 'pending' } = {}) {
	let resolveLoader;
	const loaderAwait = new Promise((resolve) => {
		resolveLoader = resolve;
	});
	const services = {
		webServer: { port },
		connection: { authenticatedUrl: (base) => `${base}/?token=s3cr3t` },
		loader: { await: () => (settle === 'none' ? undefined : loaderAwait) },
	};
	const ctx = {
		...services,
		get: (name) => (retire.includes(name) ? undefined : services[name]),
		inject: (_names, callback) => callback(ctx),
	};
	return { ctx, settleLoader: () => resolveLoader() };
}

async function announcementsFrom(options) {
	const { announceWebReady } = await import('./index.js');
	const sent = [];
	const originalSend = process.send;
	const originalConnected = process.connected;
	process.send = (message) => sent.push(message);
	process.connected = true;
	try {
		const { ctx, settleLoader } = stubContext(options);
		announceWebReady(ctx);
		settleLoader();
		// One turn for the settled continuation, which is where the announcement
		// happens whenever a loader is present.
		await Promise.resolve();
		await Promise.resolve();
		return sent;
	} finally {
		process.send = originalSend;
		process.connected = originalConnected;
	}
}

// The URL is the whole handoff: its token is the sole authentication input, and
// loading the root with it is what mints the session cookie every later request
// rides on. An origin without it answers 401.
test('announces the authenticated root URL once the tree has settled', async () => {
	assert.deepEqual(await announcementsFrom(), [
		{ type: 'pawwork:web-ready', url: 'http://127.0.0.1:43123/?token=s3cr3t' },
	]);
});

// The server binds before the tree finishes loading. Announcing on injection
// alone hands the window a URL whose page is still missing plugins.
test('waits for the loader rather than announcing when the server binds', async () => {
	const { announceWebReady } = await import('./index.js');
	const sent = [];
	const originalSend = process.send;
	const originalConnected = process.connected;
	process.send = (message) => sent.push(message);
	process.connected = true;
	try {
		const { ctx, settleLoader } = stubContext();
		announceWebReady(ctx);
		await Promise.resolve();
		assert.deepEqual(sent, []);
		settleLoader();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(sent.length, 1);
	} finally {
		process.send = originalSend;
		process.connected = originalConnected;
	}
});

// A composition with no loader has nothing to wait for, and waiting forever on
// one that does not exist is a window that never opens.
test('announces immediately when the composition has no loader', async () => {
	assert.equal((await announcementsFrom({ settle: 'none' })).length, 1);
});

// Settling can retire either service the URL is built from. A tree that lost
// one is a start that failed, and a URL assembled from what is left would name
// a port nothing is listening on.
for (const service of ['webServer', 'connection']) {
	test(`stays silent when settling retired ${service}`, async () => {
		assert.deepEqual(await announcementsFrom({ retire: [service] }), []);
	});
}
