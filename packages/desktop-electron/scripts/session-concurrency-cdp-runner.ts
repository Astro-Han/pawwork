import { runSessionConcurrencyCdp } from "./session-concurrency-cdp"

const [portValue, homeDir] = process.argv.slice(2)
const port = Number(portValue)
if (!Number.isInteger(port) || port < 1 || port > 65_535 || !homeDir) {
  throw new Error("Usage: session-concurrency-cdp-runner <cdp-port> <isolated-home>")
}

const result = await runSessionConcurrencyCdp({ port, homeDir })
console.log(JSON.stringify(result))
