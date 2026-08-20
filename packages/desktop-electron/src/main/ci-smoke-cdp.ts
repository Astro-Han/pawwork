type Env = Partial<Record<string, string | undefined>>

// The smoke harness and the app have to agree on what counts as a port: a value
// the harness passes but the app quietly drops leaves the run hanging on a CDP
// probe with nothing to read. So the rule lives here once, and the two callers
// differ only in what they do with a miss — the app ignores it, the harness
// refuses to start.
export function parseCdpPort(raw: string | undefined) {
  if (raw === undefined || raw === "" || !/^\d+$/.test(raw)) return undefined
  const port = Number(raw)
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined
}

export function ciSmokeCdpSwitches(env: Env): [string, string][] {
  if (env.PAWWORK_CI_SMOKE !== "true") return []

  const parsed = parseCdpPort(env.PAWWORK_CI_SMOKE_CDP_PORT)
  if (parsed === undefined) return []

  return [
    ["remote-debugging-port", String(parsed)],
    ["remote-debugging-address", "127.0.0.1"],
    ["remote-allow-origins", "*"],
  ]
}
