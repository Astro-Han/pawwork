import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"
import { withSession } from "../actions"

// The send/stop button mirrors `stopping = working && blank`: it carries
// data-state="running" while a task is in flight with an empty composer, and
// data-state="idle" once the task ends. We read that to assert interrupt intent.
const runningButton = '[data-action="prompt-submit"][data-state="running"]'
const idleButton = '[data-action="prompt-submit"][data-state="idle"]'

// Regression: pressing Enter on an empty composer used to abort the running
// task. Interrupting is ESC's job; Enter only ever sends.
test("empty Enter does not interrupt a running task, but ESC does", async ({ page, sdk, gotoSession, llm }) => {
  await withSession(sdk, `e2e prompt interrupt ${Date.now()}`, async (session) => {
    // The next assistant turn never completes, so the session stays working
    // until something explicitly aborts it.
    await llm.hang()

    await gotoSession(session.id)
    const prompt = page.locator(promptSelector)
    await prompt.click()
    await page.keyboard.type("keep working")
    await page.keyboard.press("Enter")

    // Task is now in flight; the composer cleared, so the button shows "stop".
    await expect(page.locator(runningButton)).toBeVisible({ timeout: 15_000 })

    // Empty Enter must be inert — the task keeps running.
    await prompt.click()
    await page.keyboard.press("Enter")
    await page.waitForTimeout(500)
    await expect(page.locator(runningButton)).toBeVisible()

    // ESC interrupts: the task ends and the button returns to the send state.
    await page.keyboard.press("Escape")
    await expect(page.locator(idleButton)).toBeVisible({ timeout: 15_000 })
  })
})
