export const name = 'pawwork-web-ready';

// Everything the announcement needs and nothing else. Sharing an entry with
// work that can fail is what makes a readiness report hostage to that work:
// this row activates as soon as the URL can be built, and no failure elsewhere
// in the product can keep it from being sent or take the runtime down with it.
export const inject = ['connection', 'webServer'];

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
export function apply(ctx) {
	// Read both services now, while this fiber is certainly active. Loading can
	// end with it disposed — its own entry rolled back, or either injected
	// service retired under it — and reading a required service off an inactive
	// context throws. That throw would land inside a `then` callback, where it
	// is an unhandled rejection, which is the whole runtime gone.
	const { connection, webServer } = ctx;
	// Whether this entry still exists. `ctx.get()` cannot answer it — on a
	// disposed fiber it keeps returning the services, which is why reading them
	// as properties is what throws — so disposal is observed where it is
	// actually reported.
	let live = true;
	ctx.effect(() => () => {
		live = false;
	});
	const announce = () => {
		if (!live) return;
		// A service retired out from under a still-live entry is the other way to
		// end up with a URL naming a port nothing holds.
		if (ctx.get('connection') === undefined) return;
		if (ctx.get('webServer') === undefined) return;
		// The channel is gone once the parent asks for a graceful stop, and there
		// is nothing left to tell it by then.
		if (!process.connected) return;
		// A reload re-runs this; the parent keeps the first URL, and the launch
		// token outlives Connection reloads, so both name one session.
		process.send({
			type: WEB_READY_MESSAGE,
			url: connection.authenticatedUrl(`http://127.0.0.1:${String(webServer.port)}`),
		});
	};
	// The server binds before the tree finishes loading, so announcing on
	// activation alone would hand over a URL whose page is still missing
	// plugins. Wait for the loader exactly as the upstream URL line does.
	const settled = ctx.get('loader')?.await();
	if (settled === undefined) announce();
	else settled.then(announce, () => {});
}
