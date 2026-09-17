/**
 * The `OAuthClientProvider` the MCP SDK drives. It owns no protocol logic: the SDK
 * performs discovery, dynamic registration, PKCE, the resource parameter and
 * refresh, and calls back here only to read and write state.
 *
 * `redirectToAuthorization` deliberately does not open a browser. The SDK calls it
 * whenever it needs a human, including from a reconnecting transport whose retry
 * loop would otherwise open a window per attempt; the URL is recorded instead and
 * the product decides when to show it.
 *
 * Because the loopback callback takes a fresh port per attempt, a client
 * registration is only reusable while the recorded redirect URI still matches.
 * A mismatch drops the registration so the SDK registers again rather than
 * sending a URI the authorization server never approved.
 */
const CLIENT_NAME = "PawWork"

/**
 * @param options.store - Grant store for this server.
 * @param options.redirectUrl - Returns the redirect URI in force right now.
 * @param options.state - Returns the CSRF state for the attempt in progress.
 * @param options.onRedirect - Called with the authorization URL when the SDK
 * needs a human.
 * @param options.onInvalidate - Called when the SDK discards held credentials.
 * @param options.serverUrl - The MCP endpoint; configured headers belong to its
 * origin alone.
 * @param options.headers - The server's configured static headers.
 */
export function createOAuthProvider(options) {
  const { store, redirectUrl, state, onRedirect, onInvalidate, signal, serverUrl, headers } = options
  const origin = new URL(serverUrl).origin

  return {
    get redirectUrl() {
      return redirectUrl()
    },
    get clientMetadata() {
      return {
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUrl()],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }
    },
    state() {
      return state()
    },
    async clientInformation() {
      const held = await store.read(signal)
      if (held.clientInformation === undefined) return undefined
      if (held.redirectUri !== redirectUrl()) {
        await store.update({ clientInformation: undefined }, signal)
        return undefined
      }
      return held.clientInformation
    },
    async saveClientInformation(clientInformation) {
      await store.update({ clientInformation, redirectUri: redirectUrl() }, signal)
    },
    async tokens() {
      return (await store.read(signal)).tokens
    },
    async saveTokens(tokens) {
      await store.update({ tokens }, signal)
    },
    async redirectToAuthorization(url) {
      signal?.throwIfAborted()
      onRedirect(String(url))
    },
    async saveCodeVerifier(codeVerifier) {
      await store.update({ codeVerifier }, signal)
    },
    async codeVerifier() {
      const held = (await store.read(signal)).codeVerifier
      if (typeof held !== "string") throw new Error("mcp-oauth: no PKCE verifier stored for this authorization attempt")
      return held
    },
    async discoveryState() {
      return (await store.read(signal)).discoveryState
    },
    async saveDiscoveryState(discoveryState) {
      await store.update({ discoveryState }, signal)
    },
    /**
     * Every request the transport makes funnels here — MCP calls, but also
     * discovery, registration and token exchange, which can live on a different
     * origin. Configured headers belong to the MCP origin alone; an
     * Authorization the SDK just minted always wins over a configured one, and
     * every request borrows the run's abort signal so teardown cancels a hung
     * exchange the transport itself would not interrupt.
     */
    fetch: (url, init) => {
      const merged = new Headers(init?.headers)
      try {
        if (new URL(url).origin === origin) {
          for (const [name, value] of Object.entries(headers ?? {})) {
            if (name.toLowerCase() === "authorization" && merged.has("authorization")) continue
            merged.set(name, value)
          }
        }
      } catch {
        // A URL the parser cannot read is not same-origin; pass it through.
      }
      return fetch(url, {
        ...init,
        headers: merged,
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
      })
    },
    /**
     * The SDK asks for this when the authorization server rejects what we hold.
     * `tokens` means the grant is gone while the registration is still good, which
     * is the "authorization expired" state the product shows.
     */
    async invalidateCredentials(scope) {
      onInvalidate?.(scope)
      if (scope === "tokens") await store.update({ tokens: undefined, codeVerifier: undefined }, signal)
      else await store.update({ tokens: undefined, codeVerifier: undefined, clientInformation: undefined, discoveryState: undefined }, signal)
    },
  }
}
