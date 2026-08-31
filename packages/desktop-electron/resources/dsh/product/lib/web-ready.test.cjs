const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Drive `apply` against a context shaped the way the harness is at the two
 * moments this cares about: activation, when the Web server has bound but the
 * tree is still loading, and settlement, when it has finished — or when this
 * entry no longer exists, which is the state that used to take the runtime down.
 */
async function announcements({ dispose = false, retire = [] } = {}) {
	const { apply } = await import('./web-ready.js');
	const sent = [];
	const originalSend = process.send;
	const originalConnected = process.connected;
	process.send = (message) => sent.push(message);
	process.connected = true;
	try {
		let resolveLoader;
		const settling = new Promise((resolve) => {
			resolveLoader = resolve;
		});
		let disposeEntry;
		const services = {
			webServer: { port: 43123 },
			connection: { authenticatedUrl: (base) => `${base}/?token=s3cr3t` },
			loader: { await: () => settling },
		};
		apply({
			...services,
			get: (name) => (retire.includes(name) ? undefined : services[name]),
			effect: (register) => {
				disposeEntry = register();
			},
		});
		// Nothing may be announced before the tree finishes loading: the server
		// binds early, and a URL handed over then names a page still missing
		// plugins.
		assert.deepEqual(sent, [], 'announced before the loader settled');
		if (dispose) disposeEntry();
		resolveLoader();
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
	assert.deepEqual(await announcements(), [
		{ type: 'pawwork:web-ready', url: 'http://127.0.0.1:43123/?token=s3cr3t' },
	]);
});

// The regression this file exists for: an entry disposed with a report still
// pending used to read a required service off an inactive context, which throws
// inside a `then` callback — an unhandled rejection that ends the sidecar.
test('stays silent, and does not throw, when this entry is disposed first', async () => {
	assert.deepEqual(await announcements({ dispose: true }), []);
});

// Settling can retire either service the URL is built from. A tree that lost
// one is a start that failed, and the URL would name a port nothing holds.
for (const service of ['webServer', 'connection']) {
	test(`stays silent when settling retired ${service}`, async () => {
		assert.deepEqual(await announcements({ retire: [service] }), []);
	});
}

// A composition with no loader has nothing to wait for, and waiting forever on
// one that does not exist is a window that never opens.
test('announces immediately when the composition has no loader', async () => {
	const { apply } = await import('./web-ready.js');
	const sent = [];
	const originalSend = process.send;
	const originalConnected = process.connected;
	process.send = (message) => sent.push(message);
	process.connected = true;
	try {
		apply({
			webServer: { port: 1 },
			connection: { authenticatedUrl: (base) => base },
			get: (name) => (name === 'loader' ? undefined : { port: 1 }),
			effect: () => () => {},
		});
		assert.equal(sent.length, 1);
	} finally {
		process.send = originalSend;
		process.connected = originalConnected;
	}
});
