import { test, expect } from "../fixtures"
import { openSidebar } from "../actions"

// Regression for the stale unread dot. A turn that finishes while the window is
// in the background is recorded as unviewed even for the session you are already
// on, and route-change used to be the only thing that cleared it — so the dot
// lingered until you navigated away and back. Returning focus to the window must
// clear the dot for the session you are viewing.
test("returning focus to the window clears the unread dot on the active session", async ({ page, project }) => {
  await project.open()

  // Pin the window as unfocused so the finishing turn is recorded as unviewed.
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false })
  })

  const sessionID = await project.prompt("ping")
  await openSidebar(page)

  const unreadDot = page
    .locator(`[data-session-id="${sessionID}"][data-component="pawwork-session-row"]`)
    .first()
    .getByRole("img", { name: "Has unread messages" })

  await expect(unreadDot).toBeVisible()

  await page.evaluate(() => window.dispatchEvent(new Event("focus")))

  await expect(unreadDot).toHaveCount(0)
})
