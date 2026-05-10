import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Locator } from "@playwright/test"
import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

async function expectOnTop(locator: Locator) {
  await expect(locator).toBeVisible()
  await expect
    .poll(async () => {
      return locator.evaluate((el) => {
        const rect = el.getBoundingClientRect()
        const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return !!target && (target === el || el.contains(target))
      })
    })
    .toBe(true)
}

async function expectViewportGap(locator: Locator) {
  await expect
    .poll(async () => {
      return locator.evaluate((el) => el.getBoundingClientRect().top)
    })
    .toBeGreaterThanOrEqual(8)
}

async function expectHoverPaint(locator: Locator) {
  await locator.hover()
  await expect
    .poll(async () => {
      return locator.evaluate((el) => getComputedStyle(el).backgroundColor)
    })
    .not.toBe("rgba(0, 0, 0, 0)")
}

test("/open opens file picker dialog", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.locator(promptSelector).click()
  await page.keyboard.type("/")

  const popover = page.locator('[data-component="prompt-slash-popover"]')
  await expectOnTop(popover)
  await expectViewportGap(popover)

  await page.keyboard.type("open")

  const command = page.locator('[data-slash-id="file.open"]')
  await expectOnTop(command)
  await expectHoverPaint(command)

  await page.keyboard.press("Enter")

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("textbox").first()).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
})

test("home composer shows slash commands after a bare slash", async ({ page, project }) => {
  await project.open()

  await page.locator(promptSelector).click()
  await page.keyboard.type("/")

  const popover = page.locator('[data-component="prompt-slash-popover"]')
  await expectOnTop(popover)
  await expectViewportGap(popover)
  const command = page.locator('[data-slash-id="file.open"]')
  await expectOnTop(command)
  await expectHoverPaint(command)
})

test("@mention file suggestions stay visible above the composer", async ({ page, project }) => {
  await project.open({
    setup: async (directory) => {
      await mkdir(join(directory, "src"), { recursive: true })
      await writeFile(join(directory, "src", "mention-target.md"), "hello")
    },
  })

  await page.locator(promptSelector).click()
  const sep = process.platform === "win32" ? "\\" : "/"
  const file = ["src", "mention-target.md"].join(sep)
  const filePattern = /src[\\/]+\s*mention-target\.md/

  await page.keyboard.type(`@${file}`)

  const popover = page.locator('[data-component="prompt-at-popover"]')
  await expectOnTop(popover)

  const suggestion = page.getByRole("button", { name: filePattern }).first()
  await expectOnTop(suggestion)
  await expectHoverPaint(suggestion)
})
