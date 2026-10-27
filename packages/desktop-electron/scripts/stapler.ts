// `xcrun stapler staple|validate <path>`, retried only when the ticket lookup
// loses its network connection; any other failure fails at once.

import { spawnSync } from "node:child_process"

// NSURLErrorDomain: timed out, cannot find host, cannot connect, connection
// lost, not connected to the internet.
const TRANSIENT_NETWORK_ERROR = /NSURLErrorDomain Code=-10(?:01|03|04|05|09)\b/
const ATTEMPTS = 6
const RETRY_DELAY_MS = 30_000

export type StaplerAction = "staple" | "validate"
export type StaplerResult = { status: number; output: string }

type Options = {
  run?: (action: StaplerAction, target: string) => StaplerResult
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

function runXcrun(action: StaplerAction, target: string): StaplerResult {
  const result = spawnSync("xcrun", ["stapler", action, "-v", target], { encoding: "utf8" })
  return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` }
}

export async function stapler(action: StaplerAction, target: string, options: Options = {}) {
  const run = options.run ?? runXcrun
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? ((line: string) => console.log(line))

  for (let attempt = 1; ; attempt++) {
    const result = run(action, target)
    log(result.output)
    if (result.status === 0 || attempt === ATTEMPTS || !TRANSIENT_NETWORK_ERROR.test(result.output)) return result.status
    log(`stapler ${action}: network error (attempt ${attempt}/${ATTEMPTS}), retrying in ${RETRY_DELAY_MS / 1_000}s`)
    await sleep(RETRY_DELAY_MS)
  }
}

if (import.meta.main) {
  const [action, target] = process.argv.slice(2)
  if ((action !== "staple" && action !== "validate") || !target) {
    console.error("Usage: tsx scripts/stapler.ts <staple|validate> <path>")
    process.exit(2)
  }
  process.exit(await stapler(action, target))
}
