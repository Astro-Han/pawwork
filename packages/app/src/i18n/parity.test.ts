import { describe, expect, test } from "bun:test"
import { formatServerError } from "../utils/server-errors"
import { dict as en } from "./en"
import { dict as zh } from "./zh"

const locales = [zh]

// A locale translator over the real dicts: returns the translation or echoes the
// key (the same contract `formatServerError`'s `tr()` sees). Used to prove that a
// provider's own reason is shown verbatim — never routed through a key — in any
// locale, so it does not need (and must not get) a translation entry.
const translatorFor = (dict: Record<string, string>) => (key: string) => dict[key] ?? key
const keys = [
  "command.session.previous.unseen",
  "command.session.next.unseen",
  "app.startup.opening",
  "home.hero.title",
  "session.panel.addTab",
  "session.panel.utility",
  "session.panel.files",
  "session.panel.changes",
  "session.review.noGitChanges",
  "session.review.noBranchChanges",
  "ui.sessionReview.title.git",
  "ui.sessionReview.title.branch",
  "ui.sessionReview.title.lastTurn",
] as const

describe("i18n parity", () => {
  test("non-English locales translate targeted session keys", () => {
    for (const locale of locales) {
      for (const key of keys) {
        expect(locale[key]).toBeDefined()
        expect(locale[key]).not.toBe(en[key])
      }
    }
  })

  // Some error text is intentionally NOT translated: a provider's own rejection
  // reason is passed through verbatim, so the user sees the real cause ("402
  // Insufficient Balance") rather than a generic localized fallback. Parity for
  // these is "same text in every locale", not "a translated key per locale".
  test("provider rejection reasons pass through verbatim in every locale", () => {
    const providerError = {
      name: "APIError",
      data: {
        message: "402 status code (no body)",
        statusCode: 402,
        responseBody: JSON.stringify({ error: { message: "Insufficient Balance", type: "unknown_error" } }),
      },
    }
    for (const dict of [en, zh]) {
      const formatted = formatServerError(providerError, translatorFor(dict))
      // The human reason, verbatim — not "unknown_error: ..." and not a localized
      // fallback.
      expect(formatted).toBe("Insufficient Balance")
      // Guard against silent regression to the old generic fallback.
      expect(formatted).not.toBe(dict["error.chain.unknown"])
    }
  })
})
