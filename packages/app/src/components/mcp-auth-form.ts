export type McpAuthMode = "bearer" | "headers"

export function readMcpAuth(headers: Record<string, string> | undefined): {
  mode: McpAuthMode
  token: string
} {
  const entries = Object.entries(headers ?? {})
  if (entries.length === 0) return { mode: "bearer", token: "" }
  if (entries.length !== 1 || entries[0]![0].toLowerCase() !== "authorization") {
    return { mode: "headers", token: "" }
  }
  const bearer = entries[0]![1].trim().match(/^Bearer\s+(.+)$/i)
  if (!bearer) return { mode: "headers", token: "" }
  return { mode: "bearer", token: bearer[1]!.trim() }
}

export function writeMcpAuth(mode: McpAuthMode, token: string, headers: Record<string, string> | undefined) {
  if (mode === "headers") return headers && Object.keys(headers).length ? headers : undefined
  const value = token.trim()
  return value ? { Authorization: `Bearer ${value}` } : undefined
}
