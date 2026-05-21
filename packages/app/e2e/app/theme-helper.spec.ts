import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { sessionComposerDockSelector } from "../selectors"
import { applyDarkModeForTests } from "../utils"

async function readHomeDockThemeColors(page: Page) {
  return page.evaluate(() => {
    const html = document.documentElement
    const card = document.querySelector('[data-component="session-new-home"] [data-dock="card"]')
    if (!(card instanceof HTMLElement)) throw new Error("Missing dock card")
    return {
      attr: html.dataset.colorScheme,
      bgBase: getComputedStyle(html).getPropertyValue("--bg-base").trim(),
      cardBackground: getComputedStyle(card).backgroundColor,
    }
  })
}

test("dark-mode e2e helper uses the real theme boot path", async ({ page, project }) => {
  await applyDarkModeForTests(page)
  await project.open()

  const home = page.locator('[data-component="session-new-home"]')
  const composerCard = home.locator(`${sessionComposerDockSelector} [data-dock="card"]`).first()
  await expect(composerCard).toBeVisible()

  const colors = await readHomeDockThemeColors(page)

  expect(colors).toEqual({
    attr: "dark",
    bgBase: "#1a1917",
    cardBackground: "rgb(38, 37, 35)",
  })
})

test("raw data-color-scheme mutation does not switch injected theme tokens", async ({ page, project }) => {
  await project.open()

  await page.evaluate(() => {
    document.documentElement.dataset.colorScheme = "dark"
  })

  const colors = await readHomeDockThemeColors(page)

  expect(colors).toEqual({
    attr: "dark",
    bgBase: "#ffffff",
    cardBackground: "rgb(255, 255, 255)",
  })
})
