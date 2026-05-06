/**
 * select-review-filter.spec.ts @smoke
 *
 * Golden-path: review panel diff-style toggle via IconButton pair that replaced RadioGroup.
 * Creates a real file diff, opens the review panel, then verifies the unified/split
 * IconButtons toggle aria-pressed correctly.
 */
import type { Page } from "@playwright/test"
import { withSession } from "../actions"
import { test, expect } from "../fixtures"
import { bodyText } from "../prompt/mock"
import { titlebarRightSelector } from "../selectors"

async function openReviewPanel(page: Page) {
  const rightToggle = page.locator(`${titlebarRightSelector} button`).first()
  const rightPanel = page.locator("#right-panel")
  const tabList = rightPanel.getByRole("tablist").first()
  const reviewTab = tabList.getByRole("tab", { name: "Review", exact: true })

  await expect(rightToggle).toBeVisible({ timeout: 10_000 })
  if ((await rightPanel.getAttribute("aria-hidden")) === "true") await rightToggle.click()
  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
  await reviewTab.click()
  await expect(reviewTab).toHaveAttribute("aria-selected", "true")
}

test("review diff-style toggle switches between unified and split @smoke", async ({
  page,
  llm,
  project,
}) => {
  await project.open()

  await withSession(project.sdk, "e2e inputs review filter toggle", async (session) => {
    project.trackSession(session.id)
    {
      const PATCH_TEXT = [
        "*** Begin Patch",
        "*** Add File: review-filter-test.txt",
        "+line one",
        "+line two",
        "*** End Patch",
      ].join("\n")

      const callsBefore = await llm.calls()
      await llm.toolMatch(
        (hit) => bodyText(hit).includes("Your only valid response is one apply_patch tool call."),
        "apply_patch",
        { patchText: PATCH_TEXT },
      )
      await project.sdk.session.prompt({
        sessionID: session.id,
        agent: "build",
        system: [
          "You are seeding deterministic e2e UI state.",
          "Your only valid response is one apply_patch tool call.",
          `Use this JSON input: ${JSON.stringify({ patchText: PATCH_TEXT })}`,
          "Do not call any other tools.",
          "Do not output plain text.",
        ].join("\n"),
        parts: [{ type: "text", text: "Apply the provided patch exactly once." }],
      })

      await expect.poll(() => llm.calls().then((c) => c > callsBefore), { timeout: 30_000 }).toBe(true)
      await expect
        .poll(
          async () => {
            const diff = await project.sdk.session.diff({ sessionID: session.id }).then((res) => res.data ?? [])
            return diff.length
          },
          { timeout: 60_000 },
        )
        .toBeGreaterThan(0)

      await project.gotoSession(session.id)
      await openReviewPanel(page)

      const unifiedBtn = page.locator('[data-component="session-review"] [aria-label*="unified" i]').first()
      const splitBtn = page.locator('[data-component="session-review"] [aria-label*="split" i]').first()

      await expect(unifiedBtn).toBeVisible({ timeout: 10_000 })
      await expect(splitBtn).toBeVisible()

      await expect(unifiedBtn).toHaveAttribute("aria-pressed", "true")
      await expect(splitBtn).toHaveAttribute("aria-pressed", "false")

      await splitBtn.click()
      await expect(splitBtn).toHaveAttribute("aria-pressed", "true")
      await expect(unifiedBtn).toHaveAttribute("aria-pressed", "false")

      await unifiedBtn.click()
      await expect(unifiedBtn).toHaveAttribute("aria-pressed", "true")
      await expect(splitBtn).toHaveAttribute("aria-pressed", "false")
    }
  })
})
