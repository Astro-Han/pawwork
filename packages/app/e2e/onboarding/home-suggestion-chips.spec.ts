import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"
import { modKey } from "../utils"

const SUGGESTION_LIST_SELECTOR = '[data-component="home-suggestion-list"]'
const ROW_SELECTOR = '[data-action="home-suggestion-row"]'
const ROW_DISMISS_SELECTOR = '[data-action="home-suggestion-row-dismiss"]'

async function readDismissedFromStorage(page: Page): Promise<string[]> {
  // settings.v3 is persisted via the settings store (utils/persist.ts) — in the
  // e2e web context this hits localStorage directly with key "settings.v3".
  return await page.evaluate(() => {
    try {
      const raw = localStorage.getItem("settings.v3")
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return parsed?.general?.homeSuggestionsDismissed ?? []
    } catch {
      return []
    }
  })
}

test("@smoke home shows 3 suggestion rows for a first-time visitor", async ({ page, project }) => {
  await project.open()

  const list = page.locator(SUGGESTION_LIST_SELECTOR)
  await expect(list).toBeVisible()
  await expect(list.locator(ROW_SELECTOR)).toHaveCount(3)
})

test("@smoke clicking a suggestion row prefills the composer", async ({ page, project }) => {
  await project.open()

  const list = page.locator(SUGGESTION_LIST_SELECTOR)
  const firstRow = list.locator(ROW_SELECTOR).first()
  const text = (await firstRow.innerText()).trim()
  await firstRow.click()

  const editor = page.locator(promptSelector)
  await expect(editor).toBeFocused()
  // contenteditable rendered via renderEditorWithCursor may include zero-width
  // chars or wrapping spans, so toHaveText (strict) is flaky. toContainText
  // asserts substring after textContent normalization which is right here.
  await expect(editor).toContainText(text)
})

test("@smoke per-row X dismisses one row and persists across reload", async ({ page, project }) => {
  await project.open()

  const list = page.locator(SUGGESTION_LIST_SELECTOR)
  await expect(list.locator(ROW_SELECTOR)).toHaveCount(3)

  const firstRow = list.locator(ROW_SELECTOR).first()
  await firstRow.hover()
  await list.locator(ROW_DISMISS_SELECTOR).first().click()

  await expect(list.locator(ROW_SELECTOR)).toHaveCount(2)

  await page.reload()
  await expect(page.locator(SUGGESTION_LIST_SELECTOR).locator(ROW_SELECTOR)).toHaveCount(2)
})

test("@smoke composer placeholder is the static home string", async ({ page, project }) => {
  await project.open()

  const editor = page.locator(promptSelector)
  await expect(editor).toBeVisible()

  // LanguageProvider persists under "pawwork.global.dat:language" with shape
  // { locale: "zh" | "en" } (see packages/app/src/context/language.tsx). Falls
  // back to "en" when unset, matching detectLocale()'s final return in a
  // CI runner where navigator.language is "en-US".
  const locale = await page.evaluate(() => {
    const raw = localStorage.getItem("pawwork.global.dat:language")
    if (!raw) return "en"
    try {
      const parsed = JSON.parse(raw) as { locale?: string }
      return parsed.locale?.startsWith?.("zh") ? "zh" : "en"
    } catch {
      return "en"
    }
  })
  const label = await editor.getAttribute("aria-label")
  // i18n source: packages/app/src/i18n/{zh,en}.ts → prompt.placeholder.home
  if (locale === "zh") {
    expect(label).toBe("输入你的任务，或 @ 引用文件")
  } else {
    expect(label).toBe("Type your task, or @ to mention files")
  }
})

test("dismissing all 3 rows hides the section entirely", async ({ page, project }) => {
  await project.open()
  const list = page.locator(SUGGESTION_LIST_SELECTOR)
  await expect(list.locator(ROW_SELECTOR)).toHaveCount(3)

  for (let i = 0; i < 3; i++) {
    const firstRow = list.locator(ROW_SELECTOR).first()
    await firstRow.hover()
    await list.locator(ROW_DISMISS_SELECTOR).first().click()
  }

  await expect(page.locator(SUGGESTION_LIST_SELECTOR)).toHaveCount(0)

  await page.reload()
  await expect(page.locator(SUGGESTION_LIST_SELECTOR)).toHaveCount(0)
})

test("used chip is gone but unused chips still appear on home after session creation", async ({
  page,
  project,
  assistant,
}) => {
  await project.open()
  await assistant.reply("unused chips remain reply")

  const list = page.locator(SUGGESTION_LIST_SELECTOR)
  const rows = list.locator(ROW_SELECTOR)
  await expect(rows).toHaveCount(3)

  const firstChipID = await rows.first().getAttribute("data-chip-id")
  expect(firstChipID).toBeTruthy()

  await rows.first().click()
  await page.keyboard.press("Enter")
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/session/")

  // Back to home: chips are NOT gated by sessionCount, so the unused two remain.
  await project.open()
  await expect(list.locator(ROW_SELECTOR)).toHaveCount(2)
  const remainingIDs = await list
    .locator(ROW_SELECTOR)
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-chip-id")))
  expect(remainingIDs).not.toContain(firstChipID)
})

test("editing a prefilled suggestion preserves the user's edit on send", async ({ page, project, assistant }) => {
  await project.open()
  await assistant.reply("edited reply")

  const editor = page.locator(promptSelector)
  await page.locator(SUGGESTION_LIST_SELECTOR).locator(ROW_SELECTOR).first().click()
  await expect(editor).toBeFocused()

  await page.keyboard.type(" please be concise")
  await page.keyboard.press("Enter")

  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/session/")
  await expect(page.getByText(/please be concise/)).toBeVisible()
})

test("clicking another suggestion replaces the previous prefill", async ({ page, project }) => {
  await project.open()

  const list = page.locator(SUGGESTION_LIST_SELECTOR)
  const editor = page.locator(promptSelector)
  const rows = list.locator(ROW_SELECTOR)

  const firstText = (await rows.first().innerText()).trim()
  const secondText = (await rows.nth(1).innerText()).trim()

  await rows.first().click()
  await expect(editor).toContainText(firstText)

  await rows.nth(1).click()
  await expect(editor).toContainText(secondText)
  await expect(editor).not.toContainText(firstText)
})

test("using a chip via send auto-dismisses it for capability discovery", async ({ page, project, assistant }) => {
  await project.open()
  await assistant.reply("auto-dismiss reply")

  const firstRow = page.locator(SUGGESTION_LIST_SELECTOR).locator(ROW_SELECTOR).first()
  const firstChipID = await firstRow.getAttribute("data-chip-id")
  expect(firstChipID).toBeTruthy()

  await firstRow.click()
  await page.keyboard.press("Enter")
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/session/")

  const dismissed = await readDismissedFromStorage(page)
  expect(dismissed).toContain(firstChipID!)
})

test("switching chips before send dismisses only the last selection", async ({ page, project, assistant }) => {
  await project.open()
  await assistant.reply("only-last reply")

  const rows = page.locator(SUGGESTION_LIST_SELECTOR).locator(ROW_SELECTOR)
  const firstChipID = await rows.first().getAttribute("data-chip-id")
  const secondChipID = await rows.nth(1).getAttribute("data-chip-id")

  await rows.first().click()
  await rows.nth(1).click()
  await page.keyboard.press("Enter")
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/session/")

  const dismissed = await readDismissedFromStorage(page)
  expect(dismissed).toContain(secondChipID!)
  expect(dismissed).not.toContain(firstChipID!)
})

test("clicking a chip then sending any content dismisses it (sticky source)", async ({ page, project, assistant }) => {
  await project.open()
  await assistant.reply("sticky source reply")

  const editor = page.locator(promptSelector)
  const firstRow = page.locator(SUGGESTION_LIST_SELECTOR).locator(ROW_SELECTOR).first()
  const firstChipID = await firstRow.getAttribute("data-chip-id")
  expect(firstChipID).toBeTruthy()

  await firstRow.click()
  await expect(editor).toBeFocused()

  // Drain the prefill, then type user-authored content. The chip source is
  // sticky once clicked — sending any prompt afterwards still dismisses it
  // (the user engaged with the suggestion and chose a direction, no need to
  // keep pitching it).
  await page.keyboard.press(`${modKey}+A`)
  await page.keyboard.press("Backspace")
  await page.keyboard.type("my own prompt content")
  await page.keyboard.press("Enter")
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/session/")

  const dismissed = await readDismissedFromStorage(page)
  expect(dismissed).toContain(firstChipID!)
})
