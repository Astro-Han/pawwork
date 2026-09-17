/**
 * The remote MCP servers this product surface owns, kept in one JSON file under
 * the harness home next to the automations file. The harness's own composition
 * files stay untouched: a server configured there by hand keeps working, and this
 * file is only what the Integrations section reads and writes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const VERSION = 1

/** One accepted entry, or a throw naming what a human has to fix. */
export function assertServer(server) {
  if (typeof server?.serverName !== "string" || server.serverName.length === 0) throw new Error("mcp-oauth: a server entry has no serverName")
  // The bridge reserves this name for tool prefixes and the credential seam needs
  // it to address a record, so it is checked before anything is written.
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(server.serverName)) throw new Error("mcp-oauth: server name " + server.serverName + " must be 1-32 of A-Z a-z 0-9 _ -")
  if (typeof server.url !== "string" || server.url.length === 0) throw new Error("mcp-oauth: server " + server.serverName + " has no url")
  try {
    const url = new URL(server.url)
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("scheme")
  } catch {
    throw new Error("mcp-oauth: server " + server.serverName + " needs an HTTPS URL (HTTP is allowed only on loopback)")
  }
  const headers = server.headers ?? {}
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) throw new Error("mcp-oauth: server " + server.serverName + " has invalid headers")
  for (const value of Object.values(headers)) {
    if (typeof value !== "string") throw new Error("mcp-oauth: server " + server.serverName + " has a non-string header value")
  }
  return { serverName: server.serverName, url: server.url, headers }
}

function parse(text) {
  const document = JSON.parse(text)
  if (document === null || typeof document !== "object" || !Array.isArray(document.servers)) {
    throw new Error("mcp-oauth: the server file has no servers array")
  }
  return document.servers.map(assertServer)
}

export function createServerList(path) {
  function read() {
    try {
      return parse(readFileSync(path, "utf8"))
    } catch (error) {
      if (error?.code === "ENOENT") return []
      throw error
    }
  }
  function write(servers) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: VERSION, servers }, null, 2) + "\n", { mode: 0o600 })
    return servers
  }
  return {
    path,
    list: read,
    replace: (servers) => write(servers.map(assertServer)),
    add(server) {
      const servers = read()
      const accepted = assertServer(server)
      if (servers.some((held) => held.serverName === accepted.serverName)) throw new Error("mcp-oauth: server " + accepted.serverName + " is already configured")
      return write([...servers, accepted])
    },
    remove(serverName) {
      const servers = read()
      return write(servers.filter((held) => held.serverName !== serverName))
    },
  }
}
