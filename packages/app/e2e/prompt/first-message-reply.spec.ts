import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { assistantText } from "../actions"

const pageErrors = (page: Page) => {
  const hits: string[] = []
  const onPageError = (err: Error) => {
    hits.push(err.stack || err.message || String(err))
  }
  page.on("pageerror", onPageError)
  return {
    hits,
    dispose: () => page.off("pageerror", onPageError),
  }
}

test("first replied message in a new session renders without page errors", async ({ page, project, assistant }) => {
  test.setTimeout(120_000)

  const token = `FIRST_REPLY_${Date.now()}`
  const errors = pageErrors(page)

  try {
    await project.open()
    await assistant.reply(token)
    const sessionID = await project.prompt(`Reply with exactly: ${token}`)
    const assistantReply = page
      .locator('[data-slot="session-turn-assistant-content"]')
      .getByText(token, { exact: true })
      .first()

    await expect.poll(() => assistantText(project.sdk, sessionID), { timeout: 30_000 }).toContain(token)
    await expect(assistantReply).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(250)
    expect(errors.hits).toEqual([])
  } finally {
    errors.dispose()
  }
})
