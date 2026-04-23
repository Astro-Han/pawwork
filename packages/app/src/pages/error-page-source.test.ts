import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"

const errorPage = readFileSync(new URL("./error.tsx", import.meta.url), "utf8")

describe("error page report fallback source contract", () => {
  test("form fallback keeps and opens the concrete feedback url", () => {
    expect(errorPage).toContain('feedbackUrl: result.status === "form-fallback" ? result.feedbackUrl : undefined')
    expect(errorPage).toContain("platform.openLink(store.feedbackUrl ?? PAWWORK_GITHUB_ISSUE_URL)")
    expect(errorPage).toContain('language.t("error.page.report.formFallbackAction")')
  })
})
