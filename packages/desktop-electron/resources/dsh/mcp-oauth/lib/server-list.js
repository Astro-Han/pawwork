/**
 * The remote MCP servers this product surface owns, kept in one JSON file under
 * the harness home next to the automations file. The harness's own composition
 * files stay untouched: a server configured there by hand keeps working, and this
 * file is only what the Integrations section reads and writes.
 *
 * A file that cannot be parsed is not an empty list — `list()` returns `[]` for
 * display but keeps the failure on `fileError`, and writes refuse rather than
 * overwrite content that may hold servers the read could not see.
 */
import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const VERSION = 1
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** One accepted entry, or a throw naming what a human has to fix. */
export function assertServer(server) {
  if (typeof server?.serverName !== "string" || server.serverName.length === 0) throw new Error("mcp-oauth: a server entry has no serverName")
  // The bridge reserves this name for tool prefixes and the credential seam needs
  // it to address a record, so it is checked before anything is written.
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(server.serverName)) throw new Error("mcp-oauth: server name " + JSON.stringify(server.serverName) + " must be 1-32 of A-Z a-z 0-9 _ -")
  if (typeof server.url !== "string" || server.url.length === 0) throw new Error("mcp-oauth: server " + server.serverName + " has no url")
  try {
    const url = new URL(server.url)
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("scheme")
    if (url.username !== "" || url.password !== "") throw new Error("credentials")
  } catch {
    throw new Error("mcp-oauth: server " + server.serverName + " needs an HTTPS URL (HTTP is allowed only on loopback) without embedded credentials")
  }
  const headers = server.headers ?? {}
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) throw new Error("mcp-oauth: server " + server.serverName + " has invalid headers")
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || name.toLowerCase() === "__proto__") throw new Error("mcp-oauth: server " + server.serverName + " has an invalid header name " + JSON.stringify(name))
    if (typeof value !== "string" || /^[ \t]|[ \t]$|[^\t\x20-\x7e\x80-\xff]/.test(value)) {
      throw new Error("mcp-oauth: server " + server.serverName + " has an invalid value for header " + JSON.stringify(name))
    }
  }
  return { serverName: server.serverName, url: server.url, headers }
}

function parse(text) {
  const document = JSON.parse(text)
  if (document === null || typeof document !== "object" || !Array.isArray(document.servers)) {
    throw new Error("mcp-oauth: the server file has no servers array")
  }
  const servers = document.servers.map(assertServer)
  if (new Set(servers.map((server) => server.serverName)).size !== servers.length) {
    throw new Error("mcp-oauth: the server file lists a serverName twice")
  }
  return servers
}

export function createServerList(path) {
  let fileError
  function read() {
    try {
      const servers = parse(readFileSync(path, "utf8"))
      fileError = undefined
      return servers
    } catch (error) {
      if (error?.code === "ENOENT") {
        fileError = undefined
        return []
      }
      fileError = error instanceof Error ? error.message : String(error)
      return []
    }
  }
  // Atomic replacement: a torn write leaves the previous file in place rather
  // than a truncated document the next start would fail to parse.
  function write(servers) {
    if (fileError !== undefined) throw new Error("mcp-oauth: the server file could not be read; refusing to overwrite it: " + fileError)
    mkdirSync(dirname(path), { recursive: true })
    const temp = path + "." + randomBytes(6).toString("hex") + ".tmp"
    try {
      writeFileSync(temp, JSON.stringify({ version: VERSION, servers }, null, 2) + "\n", { mode: 0o600, flag: "wx" })
      renameSync(temp, path)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
    return servers
  }
  return {
    path,
    /** The last read failure, or undefined when the file read clean. */
    fileError: () => fileError,
    list: read,
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
