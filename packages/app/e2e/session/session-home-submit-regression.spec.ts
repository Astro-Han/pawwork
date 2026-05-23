import type { CDPSession, Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { openSidebar, sessionIDFromUrl, waitSession } from "../actions"
import {
  pawworkSessionNewSelector,
  sessionVirtualizerSelector,
  sessionTurnListSelector,
} from "../selectors"

function collectRendererExceptions(page: Page) {
  const pageErrors: string[] = []
  const runtimeExceptions: string[] = []
  let cdp: CDPSession | undefined

  const onPageError = (error: Error) => {
    pageErrors.push(error.stack || error.message || String(error))
  }

  return {
    async start() {
      page.on("pageerror", onPageError)
      cdp = await page.context().newCDPSession(page)
      await cdp.send("Runtime.enable")
      cdp.on("Runtime.exceptionThrown", (event) => {
        const details = event.exceptionDetails
        runtimeExceptions.push(details.exception?.description || details.text || JSON.stringify(details))
      })
    },
    async stop() {
      page.off("pageerror", onPageError)
      await cdp?.detach().catch(() => undefined)
    },
    expectClean() {
      expect(pageErrors).toEqual([])
      expect(runtimeExceptions).toEqual([])
    },
  }
}

test("homepage submit enters the new session after an existing timeline was mounted", async ({
  page,
  project,
  assistant,
}) => {
  test.setTimeout(120_000)

  const exceptions = collectRendererExceptions(page)
  await exceptions.start()

  try {
    await project.open()
    await assistant.reply("mounted")
    const firstSessionID = await project.prompt(`mount existing timeline ${Date.now()}`)
    await expect(page.locator(sessionVirtualizerSelector)).toBeVisible({ timeout: 30_000 })

    await openSidebar(page)
    await page.locator(pawworkSessionNewSelector).first().click()
    await waitSession(page, { directory: project.directory, serverUrl: project.url })
    expect(sessionIDFromUrl(page.url())).toBeUndefined()

    await assistant.reply("submitted")
    const nextSessionID = await project.prompt(`submit after timeline unmount ${Date.now()}`)

    expect(nextSessionID).not.toBe(firstSessionID)
    await expect(page).toHaveURL(new RegExp(`/session/${nextSessionID}(?:[/?#]|$)`), { timeout: 30_000 })
    await expect(page.locator(sessionVirtualizerSelector)).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(sessionTurnListSelector)).toHaveAttribute("data-total-rows", /[1-9]/)
    exceptions.expectClean()
  } finally {
    await exceptions.stop()
  }
})
