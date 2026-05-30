type Env = Partial<Record<string, string | undefined>>

export function ciSmokeCdpSwitches(env: Env): [string, string][] {
  if (env.PAWWORK_CI_SMOKE !== "true") return []

  const port = env.PAWWORK_CI_SMOKE_CDP_PORT
  if (!port || !/^\d+$/.test(port)) return []

  const parsed = Number(port)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) return []

  return [
    ["remote-debugging-port", String(parsed)],
    ["remote-debugging-address", "127.0.0.1"],
    ["remote-allow-origins", "*"],
  ]
}
