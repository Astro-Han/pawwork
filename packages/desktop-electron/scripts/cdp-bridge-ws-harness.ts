// Runs under real Node with the real ws library (bundled by
// smoke-cdp-bridge-ws.ts with "ws" kept external). bun test cannot cover this
// path: under bun, "ws" resolves to Bun's native shim, whose frame-level error
// semantics differ from the production Electron main process. A malformed
// client frame makes real ws emit 'error' on the adopted socket — unhandled,
// that is an uncaught exception that kills the whole main process.
import { EventEmitter } from "node:events"
import { WebSocket } from "ws"
import { CdpBridge } from "../src/main/browser/cdp-bridge"

class FakeDebugger extends EventEmitter {
  attached = false
  isAttached() {
    return this.attached
  }
  attach() {
    this.attached = true
  }
  detach() {
    this.attached = false
  }
  async sendCommand() {
    return { ok: true }
  }
}

class FakeWebContents extends EventEmitter {
  debugger = new FakeDebugger()
  isDestroyed() {
    return false
  }
}

function fail(message: string): never {
  console.error(`SMOKE-FAIL: ${message}`)
  process.exit(1)
}

setTimeout(() => fail("timed out after 10s"), 10_000)

const bridge = new CdpBridge(new FakeWebContents() as never)
const { cdpEndpoint } = await bridge.start()

// 1. A client->server frame without MASK is a ws protocol error; the bridge
//    must drop the connection, not the process.
const first = new WebSocket(cdpEndpoint)
first.on("error", () => {})
await new Promise<void>((resolve) => first.on("open", () => resolve()))
const firstClosed = new Promise<void>((resolve) => first.on("close", () => resolve()))
const raw = (first as unknown as { _socket: { write: (chunk: Buffer) => void } })._socket
raw.write(Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])) // unmasked text "hello"
await firstClosed

// 2. The bridge must still serve: a fresh connection completes a CDP
//    round-trip. The single slot frees once the server processes the close.
let second: WebSocket | null = null
for (let attempt = 0; attempt < 50 && !second; attempt++) {
  second = await new Promise<WebSocket | null>((resolve) => {
    const candidate = new WebSocket(cdpEndpoint)
    candidate.on("error", () => resolve(null))
    candidate.on("open", () => resolve(candidate))
  })
  if (!second) await new Promise((resolve) => setTimeout(resolve, 10))
}
if (!second) fail("could not reconnect after the malformed frame")
const reply = await new Promise<{ id?: number }>((resolve) => {
  second.once("message", (data) => resolve(JSON.parse(String(data)) as { id?: number }))
  second.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {} }))
})
if (reply.id !== 1) fail(`unexpected reply: ${JSON.stringify(reply)}`)

second.terminate()
await bridge.stop()
console.log("SMOKE-OK: malformed frame dropped the connection; process and bridge survived")
process.exit(0)
