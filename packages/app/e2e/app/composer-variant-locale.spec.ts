import { expect, test } from "../fixtures"
import { promptVariantSelector } from "../selectors"

const ZH_LABELS = ["默认", "无", "极低", "低", "中", "高", "超高", "最高"]
const EN_LABELS = ["Default", "None", "Minimal", "Low", "Medium", "High", "Extra High", "Max"]

async function assertAllRenderedInSet(page: any, allowedLabels: string[]): Promise<void> {
  const menu = page.getByRole("menu")
  await expect(menu).toBeVisible()
  const items = menu.getByRole("menuitemradio")
  const count = await items.count()
  expect(count, "variant menu should render at least one option").toBeGreaterThan(0)

  for (let i = 0; i < count; i++) {
    const text = (await items.nth(i).textContent())?.trim() ?? ""
    expect(allowedLabels, `variant label "${text}" must be in the localized set`).toContain(text)
  }
}

test("zh labels localize every variant that appears for the current model", async ({ page, project }) => {
  // LanguageProvider reads from pawwork.global.dat:language (JSON {locale}), not oc_locale cookie
  await page.addInitScript(() => {
    localStorage.setItem("pawwork.global.dat:language", JSON.stringify({ locale: "zh" }))
  })
  await project.open()
  await page.locator(promptVariantSelector).click()

  await assertAllRenderedInSet(page, ZH_LABELS)
})

test("en labels localize every variant that appears for the current model", async ({ page, project }) => {
  await page.addInitScript(() => {
    localStorage.setItem("pawwork.global.dat:language", JSON.stringify({ locale: "en" }))
  })
  await project.open()
  await page.locator(promptVariantSelector).click()

  await assertAllRenderedInSet(page, EN_LABELS)
})
