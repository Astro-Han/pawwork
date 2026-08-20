import { expect, test } from "vitest"
import { PAWWORK_APP, isPawWorkChannel } from "./app-identity"

test.each(["dev", "beta", "prod"] as const)("accepts the %s channel", (channel) => {
  expect(isPawWorkChannel(channel)).toBe(true)
  expect(PAWWORK_APP[channel].id.startsWith("ai.pawwork.desktop")).toBe(true)
})

// This is the single authority three callers ask before indexing PAWWORK_APP, so
// it has to answer for inherited keys too: an `in` check says yes to "toString"
// and the packager then builds with appId undefined and productName "toString".
test.each(["toString", "constructor", "__proto__", "valueOf", "nope", ""])(
  "rejects %s as a channel",
  (raw) => {
    expect(isPawWorkChannel(raw)).toBe(false)
  },
)

test("rejects a missing channel", () => {
  expect(isPawWorkChannel(undefined)).toBe(false)
})
