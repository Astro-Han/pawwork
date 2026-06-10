// First-class surface routes (settings / automations / skills) and their
// close-to-origin contract (#1209).
//
// The desktop renderer runs a MemoryRouter: no address bar, navigation state
// is in-memory and gone after restart. Entering a surface route pushes where
// the user came from onto a flat origin stack in that navigation's OWN
// history-entry state — never a global mutable "last origin" — so multi-hop
// chains (session → automations → settings) unwind correctly, one close at a
// time. A stack entry carries the deep-entry intent its surface was opened
// with (`automationID`), so unwinding restores it.

export const SURFACE_ROUTE_PATHS = {
  settings: "/settings",
  automations: "/automations",
  skills: "/skills",
} as const

export type SurfaceRouteName = keyof typeof SURFACE_ROUTE_PATHS

export type SurfaceOrigin = {
  pathname: string
  search: string
  automationID?: string
}

// Navigation state attached to a surface-route history entry. `origins` is
// the unwind stack — last entry is where this surface was entered from;
// `automationID` is this entry's own deep-entry intent (the automate tool
// card opening one automation).
export type SurfaceRouteState = {
  origins?: SurfaceOrigin[]
  automationID?: string
}

// A hostile or buggy chain (e.g. bouncing settings ↔ automations) would grow
// the stack with every hop; the oldest entries are dropped beyond this depth,
// and close falls through to the caller's fallback once the stack runs dry.
const MAX_SURFACE_CHAIN_DEPTH = 8

export function surfaceRouteName(pathname: string): SurfaceRouteName | undefined {
  for (const [name, path] of Object.entries(SURFACE_ROUTE_PATHS)) {
    if (pathname === path) return name as SurfaceRouteName
  }
  return undefined
}

export function isSurfaceRoutePath(pathname: string) {
  return surfaceRouteName(pathname) !== undefined
}

// Builds the navigation state for entering a surface route from `location`:
// the current location — with its own deep-entry intent, if any — is pushed
// onto the stack carried in the current entry's state.
export function surfaceEntryState(input: {
  location: { pathname: string; search: string; state?: unknown }
  automationID?: string
}): SurfaceRouteState {
  const current = readSurfaceRouteState(input.location.state)
  const origins = [
    ...(current?.origins ?? []),
    {
      pathname: input.location.pathname,
      search: input.location.search,
      automationID: current?.automationID,
    },
  ].slice(-MAX_SURFACE_CHAIN_DEPTH)
  return { origins, automationID: input.automationID }
}

// An origin pathname must be an app-internal absolute path: "//host"
// (protocol-relative), backslash variants (URL parsers normalize "\" to "/"),
// and control characters would escape the app when the close handler passes
// the pathname to navigate().
const SAFE_PATHNAME = /^\/(?!\/)[^\\\u0000-\u001f]*$/

// History state crosses a structured-clone boundary and (on web) restarts, so
// treat it as untrusted input and re-validate every field. Malformed stack
// entries are dropped instead of poisoning the rest of the stack.
export function readSurfaceRouteState(state: unknown): SurfaceRouteState | undefined {
  if (!state || typeof state !== "object") return undefined
  const value = state as Record<string, unknown>
  const origins = readOrigins(value.origins)
  const automationID = typeof value.automationID === "string" ? value.automationID : undefined
  if (!origins && automationID === undefined) return undefined
  return { origins, automationID }
}

function readOrigins(value: unknown): SurfaceOrigin[] | undefined {
  if (!Array.isArray(value)) return undefined
  const origins: SurfaceOrigin[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const origin = item as Record<string, unknown>
    if (typeof origin.pathname !== "string" || !SAFE_PATHNAME.test(origin.pathname)) continue
    origins.push({
      pathname: origin.pathname,
      // A search must be empty or start with "?": anything else would splice
      // into the path ("/" + "/evil.com" would re-create a "//host" href).
      search: typeof origin.search === "string" && origin.search.startsWith("?") ? origin.search : "",
      automationID: typeof origin.automationID === "string" ? origin.automationID : undefined,
    })
  }
  if (origins.length === 0) return undefined
  return origins.slice(-MAX_SURFACE_CHAIN_DEPTH)
}

export function parseSessionRoutePath(pathname: string): { slug: string; sessionID?: string } | undefined {
  const match = /^\/([^/]+)\/session(?:\/([^/]+))?\/?$/.exec(pathname)
  if (!match) return undefined
  return { slug: match[1], sessionID: match[2] }
}

// Where "close" should land: pop the top of the origin stack. Surface-route
// origins (the previous hop of a chain) are always honored; main-area origins
// are checked with `validateOrigin` (e.g. the origin session may have been
// deleted while away), falling through to `fallback` when stale.
export function resolveSurfaceClose(input: {
  state: unknown
  validateOrigin: (origin: SurfaceOrigin) => boolean
  fallback: string
}): { href: string; state?: SurfaceRouteState } {
  const origins = readSurfaceRouteState(input.state)?.origins ?? []
  const origin = origins.at(-1)
  if (origin && (isSurfaceRoutePath(origin.pathname) || input.validateOrigin(origin))) {
    // Re-reading the popped stack through the validator collapses an empty
    // result ({} → undefined), so a fully unwound chain leaves no state.
    return {
      href: `${origin.pathname}${origin.search}`,
      state: readSurfaceRouteState({ origins: origins.slice(0, -1), automationID: origin.automationID }),
    }
  }
  return { href: input.fallback }
}
