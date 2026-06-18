// Manual validation harness for the Wave 1 Feishu scan-connect spike. Runs the
// real device-flow end to end: prints the launcher URL (you scan / authorize in
// Feishu), polls until Feishu mints the personal agent, then prints the App ID +
// App Secret (masked). Proves scan-to-connect against the live endpoint.
//
//   bun run packages/remote-bridge/src/platforms/feishu/connect-spike.ts
//
// Not shipped — delete once the Feishu adapter lands.

import { pollFeishuRegistration, startFeishuRegistration } from "./registration.ts"

function mask(secret: string): string {
  return secret.length <= 8 ? "*".repeat(secret.length) : `${secret.slice(0, 4)}...${secret.slice(-4)}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const start = await startFeishuRegistration()
console.log("\nScan this with Feishu (扫一扫), or open it and authorize:\n")
console.log("  " + start.verificationUri)
console.log("\n  user code: " + start.userCode)
console.log(`  valid for ~${Math.round(start.expiresInMs / 60_000)} min\n`)
console.log("Waiting for approval in Feishu")

const deadline = Date.now() + start.expiresInMs
let domain = start.domain
while (Date.now() < deadline) {
  await delay(start.intervalMs)
  const poll = await pollFeishuRegistration(start.deviceCode, domain)
  if (poll.status === "pending") {
    domain = poll.domain
    process.stdout.write(".")
    continue
  }
  if (poll.status === "error") {
    console.error("\n\nRegistration failed: " + poll.message)
    process.exit(1)
  }
  console.log("\n\nConnected — Feishu minted a personal agent:")
  console.log("  domain:     " + poll.domain)
  console.log("  app id:     " + poll.appId)
  console.log("  app secret: " + mask(poll.appSecret))
  console.log("\nThese are the credentials the Feishu adapter feeds to the WSClient long connection.")
  process.exit(0)
}
console.error("\n\nTimed out waiting for approval.")
process.exit(1)
