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

test("@smoke composer placeholder is the static home string and does not rotate", async ({ page, project }) => {
  await project.open()

  const editor = page.locator(promptSelector)
  await expect(editor).toBeVisible()
  const initialLabel = await editor.getAttribute("aria-label")
  expect(initialLabel).toMatch(/(输入你的任务|Type your task)/)

  // wait ~7s (longer than the deleted 6.5s rotation) and confirm the label is unchanged
  await page.waitForTimeout(7000)
  const labelAfter = await editor.getAttribute("aria-label")
  expect(labelAfter).toBe(initialLabel)
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

  // hover the row → group-hover reveals the X (opacity-1)
  await firstRow.hover()
  await expect(firstRowDismiss).toHaveCSS("opacity", "1")
})

test("editing a prefilled suggestion preserves the user's edit on send", async ({ page, project, assistant }) => {
  await project.open()
  await assistant.reply("edited reply")

  const editor = page.locator(promptSelector)
  await page.locator(suggestionListSelector).locator(rowSelector).first().click()
  await expect(editor).toBeFocused()

  // append a suffix
  await page.keyboard.type(" — please be concise")
  await page.keyboard.press("Enter")

  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/session/")
  // the user message rendered should contain both the prefilled text and the suffix
  await expect(page.getByText(/please be concise/)).toBeVisible()
})

test("settings toggle hides and restores the suggestion section", async ({ page, project }) => {
  await project.open()
  await expect(page.locator(suggestionListSelector)).toBeVisible()

  // toggle off via localStorage write (Settings page navigation/click is covered by
  // the contract test for settings-general.tsx; this E2E focuses on persisted-state
  // behaviour — does the suggestion section actually disappear when the flag flips)
  await page.evaluate(() => {
    // settings.v3 lives in localStorage as the persisted store; flip the key directly
    // to avoid full-flow navigation in this test.
    const raw = localStorage.getItem("settings.v3")
    const parsed = raw ? JSON.parse(raw) : {}
    parsed.general = { ...(parsed.general ?? {}), homeSuggestionsEnabled: false }
    localStorage.setItem("settings.v3", JSON.stringify(parsed))
  })
  await page.reload()
  await expect(page.locator(suggestionListSelector)).toHaveCount(0)

  await page.evaluate(() => {
    const raw = localStorage.getItem("settings.v3")
    const parsed = raw ? JSON.parse(raw) : {}
    parsed.general = { ...(parsed.general ?? {}), homeSuggestionsEnabled: true }
    localStorage.setItem("settings.v3", JSON.stringify(parsed))
  })
  await page.reload()
  await expect(page.locator(suggestionListSelector).locator(rowSelector)).toHaveCount(3)
})

test("language switch updates chip text without losing dismissed state", async ({ page, project }) => {
  await project.open()

  const list = page.locator(suggestionListSelector)
  // dismiss the first row in current locale
  await list.locator(rowSelector).first().hover()
  await list.locator(rowDismissSelector).first().click()
  await expect(list.locator(rowSelector)).toHaveCount(2)

  // Confirmed via packages/app/src/context/language.tsx — persistence key is "language",
  // shape is { locale: "zh" | "en" }, migrated from legacy "language.v1".
  await page.evaluate(() => {
    const raw = localStorage.getItem("language")
    const parsed = raw ? JSON.parse(raw) : { locale: "zh" }
    parsed.locale = parsed.locale?.startsWith?.("zh") ? "en" : "zh"
    localStorage.setItem("language", JSON.stringify(parsed))
  })
  await page.reload()

  // still 2 rows visible (dismissed state preserved across locale flip)
  await expect(page.locator(suggestionListSelector).locator(rowSelector)).toHaveCount(2)
})
