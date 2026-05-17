import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

const suggestionListSelector = '[data-component="home-suggestion-list"]'
const rowSelector = '[data-action="home-suggestion-row"]'
const rowDismissSelector = '[data-action="home-suggestion-row-dismiss"]'

test("@smoke home shows 3 suggestion rows for a first-time visitor", async ({ page, project }) => {
  await project.open()

  const list = page.locator(suggestionListSelector)
  await expect(list).toBeVisible()
  await expect(list.locator(rowSelector)).toHaveCount(3)
})

test("@smoke clicking a suggestion row prefills the composer", async ({ page, project }) => {
  await project.open()

  const list = page.locator(suggestionListSelector)
  const firstRow = list.locator(rowSelector).first()
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

  const list = page.locator(suggestionListSelector)
  await expect(list.locator(rowSelector)).toHaveCount(3)

  const firstRow = list.locator(rowSelector).first()
  await firstRow.hover()
  await list.locator(rowDismissSelector).first().click()

  await expect(list.locator(rowSelector)).toHaveCount(2)

  await page.reload()
  await expect(page.locator(suggestionListSelector).locator(rowSelector)).toHaveCount(2)
})

test("@smoke composer placeholder is the static home string", async ({ page, project }) => {
  await project.open()

  const editor = page.locator(promptSelector)
  await expect(editor).toBeVisible()

  // Persistence key is "language", shape is { locale: "zh" | "en" }, confirmed
  // via packages/app/src/context/language.tsx.
  const locale = await page.evaluate(() => {
    const raw = localStorage.getItem("language")
    const parsed = raw ? JSON.parse(raw) : { locale: "zh" }
    return parsed.locale?.startsWith?.("zh") ? "zh" : "en"
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
  const list = page.locator(suggestionListSelector)
  await expect(list.locator(rowSelector)).toHaveCount(3)

  for (let i = 0; i < 3; i++) {
    const firstRow = list.locator(rowSelector).first()
    await firstRow.hover()
    await list.locator(rowDismissSelector).first().click()
  }

  await expect(page.locator(suggestionListSelector)).toHaveCount(0)

  await page.reload()
  await expect(page.locator(suggestionListSelector)).toHaveCount(0)
})

test("returning visitor (sessions > 0) sees no suggestion list", async ({ page, project, assistant }) => {
  await project.open()

  await assistant.reply("reply to trigger a session")
  await page.locator(promptSelector).click()
  await page.keyboard.type("first prompt")
  await page.keyboard.press("Enter")
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/session/")

  await project.open()
  await expect(page.locator(suggestionListSelector)).toHaveCount(0)
})

test("editing a prefilled suggestion preserves the user's edit on send", async ({ page, project, assistant }) => {
  await project.open()
  await assistant.reply("edited reply")

  const editor = page.locator(promptSelector)
  await page.locator(suggestionListSelector).locator(rowSelector).first().click()
  await expect(editor).toBeFocused()

  await page.keyboard.type(" please be concise")
  await page.keyboard.press("Enter")

  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/session/")
  await expect(page.getByText(/please be concise/)).toBeVisible()
})

test("clicking a chip with user-typed content does NOT overwrite the user content", async ({ page, project }) => {
  await project.open()

  const editor = page.locator(promptSelector)
  await editor.click()
  await page.keyboard.type("my own draft text")
  await expect(editor).toContainText("my own draft text")

  await page.locator(suggestionListSelector).locator(rowSelector).first().click()
  await expect(editor).toBeFocused()
  await expect(editor).toContainText("my own draft text")
})
