import type { ServerReadyData } from "../preload/types"

export type InternalFetchError = { ok: false; error: string }
export type InternalFetchOk = { ok: true; body: string }

export function buildExportUrl(server: Pick<ServerReadyData, "url">, directory: string, sessionID: string) {
  // Locked from pre-flight: directory is a QUERY PARAM (consumed by instance middleware),
  // NOT a path segment. The full URL is `<base>/session/<sessionID>/export?directory=<encoded>`.
  const base = server.url.replace(/\/$/, "")
  const url = new URL(`${base}/session/${encodeURIComponent(sessionID)}/export`)
  url.searchParams.set("directory", directory)
  return url.toString()
}

export function buildAuthHeader(server: Pick<ServerReadyData, "username" | "password">): Record<string, string> {
  if (server.username || server.password) {
    // Fallback `"opencode"` username when only password is set matches main/index.ts:170
    // (the existing internal-fetch path) so dev installs that omit username still authenticate.
    return {
      Authorization:
        "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password ?? ""}`).toString("base64"),
    }
  }
  return {}
}

// Same 10s ceiling as the existing feedback/session-export internal fetch in main/index.ts;
// if the embedded server (or any future remote target) stalls, the renderer surfaces a real
// error toast instead of an indefinitely-pending Promise.
const FETCH_TIMEOUT_MS = 10_000

export async function fetchExport(
  server: ServerReadyData,
  directory: string,
  sessionID: string,
): Promise<InternalFetchOk | InternalFetchError> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(buildExportUrl(server, directory, sessionID), {
      headers: buildAuthHeader(server),
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, error: `server_${res.status}` }
    return { ok: true, body: await res.text() }
  } catch (err) {
    const message = (err as Error).name === "AbortError" ? "timeout" : (err as Error).message
    return { ok: false, error: message }
  } finally {
    clearTimeout(timer)
  }
}
