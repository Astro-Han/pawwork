import { test } from "../fixtures"
import { promptSelector } from "../selectors"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

async function snapComposer(page: import("@playwright/test").Page, name: string): Promise<Shot> {
  const prompt = page.locator(promptSelector)
  await prompt.waitFor({ state: "visible", timeout: 30_000 })
  const placeholder = page.locator('[data-component="prompt-placeholder"]')
  await placeholder.waitFor({ state: "visible", timeout: 30_000 })
  return { name, buf: await prompt.screenshot() }
}

test("prompt-placeholder", async ({ page, project }) => {
  test.setTimeout(180_000)

  await project.open()
  const enShot = await snapComposer(page, "en")

  // Client-side locale is sourced from localStorage. Set it, reload, re-snap.
  await page.evaluate(() => {
    localStorage.setItem("pawwork.global.dat:language", JSON.stringify({ locale: "zh" }))
  })
  await page.reload()
  const zhShot = await snapComposer(page, "zh")

  const out = snapOutputPath("prompt-placeholder")
  await composeGrid([enShot, zhShot], out)
  process.stdout.write(`\n[snap] prompt-placeholder grid -> ${out}\n\n`)
})
