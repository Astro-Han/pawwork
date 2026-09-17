/**
 * One remote MCP server's OAuth material, kept in the harness credential seam as
 * a grant record, so tokens live where every other credential lives and survive a
 * restart without a second store.
 *
 * Records are addressed as `<scope>/<id>` with both segments lowercase and
 * hyphenated, while a server name may carry uppercase and underscores. The key is
 * therefore a lossless encoding and the payload restates the real identity: a
 * record whose server URL no longer matches the configuration reads as empty
 * instead of handing another server's grant to this one.
 */
const SCOPE = "mcp-oauth"

/** Credential record key for one remote MCP server. */
export function grantKey(serverName) {
  return SCOPE + "/s-" + Buffer.from(serverName, "utf8").toString("hex")
}

/**
 * @param credentials - The harness credential provider (`ctx.credentials`).
 * @param identity - The server this store belongs to; both fields are verified on
 * every read.
 */
export function createGrantStore(credentials, identity) {
  const key = grantKey(identity.serverName)
  const empty = () => ({})

  async function payload(signal) {
    signal?.throwIfAborted()
    const record = await credentials.readRecord(key)
    signal?.throwIfAborted()
    const held = record?.kind === "grant" ? record.payload : undefined
    if (held === null || typeof held !== "object") return empty()
    if (held.serverName !== identity.serverName || held.serverUrl !== identity.serverUrl) return empty()
    return held
  }

  return {
    key,
    /** Everything stored for this server, or an empty object. */
    read: payload,
    /** Read-modify-write one patch into the record. */
    async update(patch, signal) {
      await credentials.modifyRecord(key, async (current) => {
        signal?.throwIfAborted()
        const held = current?.kind === "grant" ? current.payload : undefined
        const base = held === null || typeof held !== "object" || held.serverName !== identity.serverName || held.serverUrl !== identity.serverUrl ? {} : held
        // SDK optional fields use undefined; persisted grants contain JSON only.
        // Serializing after the merge also removes fields explicitly cleared.
        return { kind: "grant", payload: JSON.parse(JSON.stringify({ ...base, ...identity, ...patch })) }
      })
    },
    /** Drop every trace of this server's grant. */
    async clear() {
      await credentials.deleteRecord(key)
    },
  }
}
