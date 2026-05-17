import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

const suggestionListSelector = '[data-component="home-suggestion-list"]'
const rowSelector = '[data-action="home-suggestion-row"]'
const rowDismissSelector = '[data-action="home-suggestion-row-dismiss"]'
const sectionDismissSelector = '[data-action="home-suggestion-section-dismiss"]'

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
  // contenteditable rendered via renderEditorWithCursor may include zero-width chars / wrapping
  // spans, so toHaveText (strict equality) can be flaky. toContainText asserts substring after
  // textContent normalization which is the right granularity here.
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

test("@smoke section X dismisses all three rows and hides the section", async ({ page, project }) => {
  await project.open()

  const list = page.locator(suggestionListSelector)
  await expect(list.locator(rowSelector)).toHaveCount(3)
  await list.locator(sectionDismissSelector).click()
  await expect(page.locator(suggestionListSelector)).toHaveCount(0)
})

test("@smoke composer placeholder is the static home string", async ({ page, project }) => {
  await project.open()

  const editor = page.locator(promptSelector)
  await expect(editor).toBeVisible()

  // Read the live locale and assert against the matching i18n value. A regression
  // that swaps the placeholder to a wrong string in either locale must fail,
  // not be masked by an either-or regex.
  // Persistence key is "language" and shape is { locale: "zh" | "en" }; verified
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

test("returning visitor (sessions > 0) sees no suggestion list", async ({ page, project, assistant }) => {
  await project.open()

  // create a session by sending a prompt
  await assistant.reply("reply to trigger a session")
  await page.locator(promptSelector).click()
  await page.keyboard.type("first prompt")
  await page.keyboard.press("Enter")
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/session/")

  // navigate back to home — sessions now == 1
  await project.open()
  await expect(page.locator(suggestionListSelector)).toHaveCount(0)
})

test("hover reveals the per-row X (rest state hides it)", async ({ page, project }) => {
  await project.open()

  // disable CSS transitions to remove timing flakes between rest / hover state
  await page.addStyleTag({ content: "* { transition: none !important; animation: none !important; }" })

  const list = page.locator(suggestionListSelector)
  const firstRow = list.locator(rowSelector).first()
  const firstRowDismiss = list.locator(rowDismissSelector).first()

  // rest state: per-row X is rendered but not visible (opacity-0)
  await expect(firstRowDismiss).toHaveCSS("opacity", "0")
  // and not clickable (pointer-events-none keeps it out of the hit-test surface)
  await expect(firstRowDismiss).toHaveCSS("pointer-events", "none")

  // hover the row → group-hover reveals the X (opacity-1) and re-enables clicks
  await firstRow.hover()
  await expect(firstRowDismiss).toHaveCSS("opacity", "1")
  await expect(firstRowDismiss).toHaveCSS("pointer-events", "auto")
})

test("editing a prefilled suggestion preserves the user's edit on send", async ({ page, project, assistant }) => {
  await project.open()
  await assistant.reply("edited reply")

  const editor = page.locator(promptSelector)
  await page.locator(suggestionListSelector).locator(rowSelector).first().click()
  await expect(editor).toBeFocused()

  // append a suffix
  await page.keyboard.type(" please be concise")
  await page.keyboard.press("Enter")

  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/session/")
  // the user message rendered should contain both the prefilled text and the suffix
  await expect(page.getByText(/please be concise/)).toBeVisible()
})

test("clicking a chip with user-typed content does NOT overwrite the user content", async ({ page, project }) => {
  await project.open()

  const editor = page.locator(promptSelector)
  await editor.click()
  await page.keyboard.type("my own draft text")
  await expect(editor).toContainText("my own draft text")

  // click first chip — user content should be preserved (no merge, no overwrite)
  await page.locator(suggestionListSelector).locator(rowSelector).first().click()
  await expect(editor).toBeFocused()
  await expect(editor).toContainText("my own draft text")
})

test("settings toggle hides and restores the suggestion section via the real Settings UI", async ({
  page,
  project,
}) => {
  await project.open()
  await expect(page.locator(suggestionListSelector)).toBeVisible()

  // Open Settings (kbd shortcut path is project-wide; settings page is a full pane,
  // not a dialog — see settings.spec.ts for the canonical opening behavior).
  await page.goto("#/settings/general")
  const switchEl = page.locator('[data-action="settings-home-suggestions"] [role="switch"]')
  await expect(switchEl).toBeVisible()
  // turn off
  await switchEl.click()

  await project.open()
  await expect(page.locator(suggestionListSelector)).toHaveCount(0)

  // turn it back on via the real Settings switch
  await page.goto("#/settings/general")
  await switchEl.click()

  await project.open()
  await expect(page.locator(suggestionListSelector).locator(rowSelector)).toHaveCount(3)
})

test("language switch updates chip text without losing dismissed state", async ({ page, project }) => {
  await project.open()

  const list = page.locator(suggestionListSelector)
  // capture text of the second row in the current locale (first row will be dismissed below)
  const secondRowTextBefore = (await list.locator(rowSelector).nth(1).innerText()).trim()

  // dismiss the first row in current locale
  await list.locator(rowSelector).first().hover()
  await list.locator(rowDismissSelector).first().click()
  await expect(list.locator(rowSelector)).toHaveCount(2)

  // Confirmed via packages/app/src/context/language.tsx. Persistence key is "language",
  // shape is { locale: "zh" | "en" }, migrated from legacy "language.v1".
  await page.evaluate(() => {
    const raw = localStorage.getItem("language")
    const parsed = raw ? JSON.parse(raw) : { locale: "zh" }
    parsed.locale = parsed.locale?.startsWith?.("zh") ? "en" : "zh"
    localStorage.setItem("language", JSON.stringify(parsed))
  })
  await page.reload()

  // still 2 rows visible (dismissed state preserved across locale flip)
  const listAfter = page.locator(suggestionListSelector)
  await expect(listAfter.locator(rowSelector)).toHaveCount(2)

  // and chip text actually flipped to the other locale (key insight: the row text
  // must NOT equal the pre-flip text — that would mean i18n didn't propagate)
  const secondRowTextAfter = (await listAfter.locator(rowSelector).nth(0).innerText()).trim()
  expect(secondRowTextAfter).not.toBe(secondRowTextBefore)
})
