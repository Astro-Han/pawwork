import { readFileSync } from "node:fs"
import { test, expect } from "bun:test"

const source = readFileSync(new URL("./rate-limit-card-wiring.tsx", import.meta.url), "utf8")

test("OpenCode Go subscription opens PawWork referral link", () => {
  expect(source).toContain('const SUBSCRIBE_URL = "https://opencode.ai/go?ref=V1WTSZKC69"')
})
