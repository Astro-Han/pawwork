import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"
import { withSession } from "../actions"

// The send/stop button mirrors `stopping = working && blank`: it carries
// data-state="running" while a task is in flight with an empty composer, and
// data-state="idle" once the task ends.
const runningButton = '[data-action="prompt-submit"][data-state="running"]'
const idleButton = '[data-action="prompt-submit"][data-state="idle"]'

// Regression: pressing Enter on an empty composer used to abort the running
// task. Interrupting is ESC's job; Enter only ever sends.
test("empty Enter does not interrupt a running task, but ESC does", async ({ page, sdk, gotoSession, llm }) => {
  await withSession(sdk, `e2e prompt interrupt ${Date.now()}`, async (session) => {
    // The next assistant turn never completes, so the session stays working
    // until something explicitly aborts it.
    await llm.hang()

    // Record every session-abort request with its source. The renderer tags ESC
    // interrupts "renderer.escape"; an erroneous Enter abort would land here as a
    // different (or extra) entry — a deterministic check, no fixed sleep needed.
    const abortSources: string[] = []
    page.on("request", (req) => {
      const url = new URL(req.url())
      if (req.method() === "POST" && url.pathname.endsWith("/abort")) {
        abortSources.push(url.searchParams.get("source") ?? "")
      }
    })

    await gotoSession(session.id)
    const prompt = page.locator(promptSelector)
    await prompt.click()
    await page.keyboard.type("keep working")
    await page.keyboard.press("Enter")

    // Wait until the server actually reaches the (hanging) assistant call, so the
    // task is genuinely in flight — not merely optimistically busy — before we
    // test interruption. This also consumes the queued hang.
    await expect.poll(() => llm.calls(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    await expect(page.locator(runningButton)).toBeVisible({ timeout: 15_000 })

    // Empty Enter must be inert; ESC must interrupt. Pressing Enter first then
    // ESC, the only abort we should ever observe is ESC's. (If Enter wrongly
    // aborted, it would fire first and this assertion would never match.)
    await prompt.click()
    await page.keyboard.press("Enter")
    await page.keyboard.press("Escape")

    await expect.poll(() => abortSources, { timeout: 15_000 }).toEqual(["renderer.escape"])
    await expect(page.locator(idleButton)).toBeVisible({ timeout: 15_000 })
  })
})
