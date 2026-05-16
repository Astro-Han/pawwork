import { test, expect } from "../fixtures"
import { sessionComposerDockSelector } from "../selectors"
import { applyDarkModeForTests } from "../utils"

test("dark-mode e2e helper uses the real theme boot path", async ({ page, project }) => {
  await applyDarkModeForTests(page)
  await project.open()

  const home = page.locator('[data-component="session-new-home"]')
  const composerCard = home.locator(`${sessionComposerDockSelector} [data-dock="card"]`).first()
  await expect(composerCard).toBeVisible()

  const colors = await page.evaluate(() => {
    const html = document.documentElement
    const card = document.querySelector('[data-component="session-new-home"] [data-dock="card"]')
    if (!(card instanceof HTMLElement)) throw new Error("Missing dock card")
    return {
      attr: html.dataset.colorScheme,
      bgBase: getComputedStyle(html).getPropertyValue("--bg-base").trim(),
      cardBackground: getComputedStyle(card).backgroundColor,
    }
  })

  expect(colors).toEqual({
    attr: "dark",
    bgBase: "#1a1714",
    cardBackground: "rgb(58, 52, 49)",
  })
})

test("raw data-color-scheme mutation does not switch injected theme tokens", async ({ page, project }) => {
  await project.open()

  await page.evaluate(() => {
    document.documentElement.dataset.colorScheme = "dark"
  })

  const colors = await page.evaluate(() => {
    const html = document.documentElement
    const card = document.querySelector('[data-component="session-new-home"] [data-dock="card"]')
    if (!(card instanceof HTMLElement)) throw new Error("Missing dock card")
    return {
      attr: html.dataset.colorScheme,
      bgBase: getComputedStyle(html).getPropertyValue("--bg-base").trim(),
      cardBackground: getComputedStyle(card).backgroundColor,
    }
  })

  expect(colors).toEqual({
    attr: "dark",
    bgBase: "#ffffff",
    cardBackground: "rgb(255, 255, 255)",
  })
})
