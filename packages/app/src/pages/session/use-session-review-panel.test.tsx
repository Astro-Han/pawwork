import { describe, expect, test } from "bun:test"

describe("createSessionReviewPanel", () => {
  test("does not keep the old Files panel auto-open path", async () => {
    const source = await Bun.file(new URL("./use-session-review-panel.tsx", import.meta.url)).text()

    expect(source).not.toContain("nextFilesPanelAutoOpen")
    expect(source).not.toContain('openTab("files")')
    expect(source).not.toContain('setTab("files")')
    expect(source).not.toContain('toggleTab("files")')
    expect(source).not.toContain("sidePanel.open()")
  })
})
