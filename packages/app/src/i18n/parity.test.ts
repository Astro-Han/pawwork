import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as zh } from "./zh"

const locales = [zh]
const keys = [
  "command.session.previous.unseen",
  "command.session.next.unseen",
  "session.new.title",
  "session.new.card.document.title",
  "session.new.card.document.description",
  "session.new.card.analysis.title",
  "session.new.card.analysis.description",
  "session.new.card.writing.title",
  "session.new.card.writing.description",
  "session.panel.addTab",
  "session.panel.utility",
  "session.panel.files",
  "session.panel.changes",
  "session.review.noUnstagedChanges",
  "session.review.noStagedChanges",
  "session.review.noBranchChanges",
  "ui.sessionReview.title.unstaged",
  "ui.sessionReview.title.staged",
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
})
