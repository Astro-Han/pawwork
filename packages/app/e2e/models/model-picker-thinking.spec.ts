import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"

type ModelKey = {
  providerID: string
  modelID: string
}

type Probe = {
  model?: ModelKey
  variant?: string | null
  selected?: string | null
  variants?: string[]
  models?: Array<ModelKey & { name: string }>
}

async function probe(page: Page): Promise<Probe | null> {
  return page.evaluate(() => {
    const win = window as Window & {
      __opencode_e2e?: {
        model?: {
          current?: Probe
          controls?: {
            setModel?: (value: ModelKey | undefined) => void
            setVariant?: (value: string | undefined) => void
          }
        }
      }
    }
    return win.__opencode_e2e?.model?.current ?? null
  })
}

async function setModel(page: Page, value: ModelKey) {
  await page.evaluate((value) => {
    const win = window as Window & {
      __opencode_e2e?: {
        model?: {
          controls?: {
            setModel?: (value: ModelKey | undefined) => void
          }
        }
      }
    }
    const fn = win.__opencode_e2e?.model?.controls?.setModel
    if (!fn) throw new Error("Model e2e model control is not enabled")
    fn(value)
  }, value)
}

async function setVariant(page: Page, value: string | undefined) {
  await page.evaluate((value) => {
    const win = window as Window & {
      __opencode_e2e?: {
        model?: {
          controls?: {
            setVariant?: (value: string | undefined) => void
          }
        }
      }
    }
    const fn = win.__opencode_e2e?.model?.controls?.setVariant
    if (!fn) throw new Error("Model e2e variant control is not enabled")
    fn(value)
  }, value)
}

async function chooseModelWithVariants(page: Page): Promise<string[] | undefined> {
  await expect.poll(() => probe(page).then((state) => state?.models?.length ?? 0), { timeout: 30_000 }).toBeGreaterThan(0)

  const candidates = (await probe(page))?.models ?? []
  for (const candidate of candidates) {
    await setModel(page, candidate)
    await expect
      .poll(() => probe(page).then((state) => `${state?.model?.providerID}:${state?.model?.modelID}`), {
        timeout: 30_000,
      })
      .toBe(`${candidate.providerID}:${candidate.modelID}`)

    const variants = (await probe(page))?.variants ?? []
    if (variants.length > 0) return variants
  }

  return undefined
}

test("@smoke thinking option click updates variant from nested model picker", async ({ page, project }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await project.open()

  const variants = await chooseModelWithVariants(page)
  test.skip(!variants, "no visible e2e model with thinking variants")
  if (!variants) return
  const target = variants.includes("xhigh") ? "xhigh" : variants[0]
  if (!target) throw new Error("Expected at least one thinking variant")

  await setVariant(page, undefined)
  await expect.poll(() => probe(page).then((state) => state?.variant ?? null), { timeout: 30_000 }).toBe(null)

  await page.locator('[data-action="prompt-model"]').first().click()

  const thinkingTrigger = page.locator('[data-action="prompt-model-thinking-trigger"]').first()
  await expect(thinkingTrigger).toBeVisible()
  await expect(thinkingTrigger).toBeEnabled()
  await thinkingTrigger.click()

  const option = page.locator(`[data-action="prompt-model-thinking-option"][data-variant="${target}"]`).first()
  await expect(option).toBeVisible()
  await option.click()

  await expect.poll(() => probe(page).then((state) => state?.selected ?? null), { timeout: 30_000 }).toBe(target)
  await expect.poll(() => probe(page).then((state) => state?.variant ?? null), { timeout: 30_000 }).toBe(target)
})
