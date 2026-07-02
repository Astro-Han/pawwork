import { describe, expect, test } from "bun:test"
import { dict as enDict } from "./en"
import { dict as zhDict } from "./zh"
import { dict as zhtDict } from "./zht"

const en = enDict as Record<string, string>
const zh = zhDict as Record<string, string>
const zht = zhtDict as Record<string, string>

// Both shipped Chinese locales must mirror the card copy. en is the base every
// other locale falls back to, so a missing zh/zht key would silently render
// English; these assertions catch the regression types don't (parity is
// enforced here, not by the dict types).
const LOCALES = [
  ["zh", zh],
  ["zht", zht],
] as const

const KINDS = [
  "auth",
  "quota_exhausted",
  "invalid_request",
  "rate_limit",
  "server_overload",
  "transport_disconnect",
  "decompression",
  "unknown",
] as const

const ACTIONABLE = ["auth", "quota_exhausted", "invalid_request"] as const

// A real translation: present, not a key echo, and not just the English string.
function expectLocalized(dict: Record<string, string>, key: string) {
  expect(dict[key]).toBeDefined()
  expect(dict[key]).not.toBe(key)
  expect(dict[key]).not.toBe(en[key])
}

describe("error card translations", () => {
  // en is the base every locale falls back to, so its copy is what users on the
  // 14 untranslated locales actually see. Lock the full set in.
  test("en defines the base copy for every key", () => {
    for (const kind of KINDS) {
      expect(en[`ui.errorCard.${kind}.title`]).toBeDefined()
      const body = en[`ui.errorCard.${kind}.body`]
      if (kind === "unknown") expect(body).toBeUndefined()
      else expect(body).toBeDefined()
    }
    for (const kind of ACTIONABLE) expect(en[`ui.errorCard.${kind}.action`]).toBeDefined()
    expect(en["ui.errorCard.detail"]).toBeDefined()
  })

  for (const [name, dict] of LOCALES) {
    test(`${name} has a real title for every kind`, () => {
      for (const kind of KINDS) expectLocalized(dict, `ui.errorCard.${kind}.title`)
    })

    test(`${name} has a real body for every non-unknown kind (unknown shows the decoded reason instead)`, () => {
      for (const kind of KINDS) {
        const key = `ui.errorCard.${kind}.body`
        if (kind === "unknown") {
          expect(dict[key]).toBeUndefined()
          expect(en[key]).toBeUndefined()
          continue
        }
        expectLocalized(dict, key)
      }
    })

    test(`${name} has a localized action label for every actionable kind`, () => {
      for (const kind of ACTIONABLE) expectLocalized(dict, `ui.errorCard.${kind}.action`)
    })

    test(`${name} localizes the detail disclosure label`, () => {
      expectLocalized(dict, "ui.errorCard.detail")
    })
  }

  test("the trigger-bug wording is pinned", () => {
    // 402 "Insufficient Balance" must read as the real reason, not "Connection lost".
    expect(zh["ui.errorCard.quota_exhausted.title"]).toBe("余额不足")
    expect(zht["ui.errorCard.quota_exhausted.title"]).toBe("餘額不足")
    expect(zh["ui.errorCard.detail"]).toBe("详情")
    expect(zht["ui.errorCard.detail"]).toBe("詳情")
  })
})
