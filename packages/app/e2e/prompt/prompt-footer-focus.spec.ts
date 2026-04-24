import type { Locator, Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { promptAgentSelector, promptModelSelector, promptSelector } from "../selectors"

type Probe = {
  agent?: string
  model?: { providerID: string; modelID: string; name?: string }
  models?: Array<{ providerID: string; modelID: string; name: string }>
  agents?: Array<{ name: string }>
}

async function probe(page: Page): Promise<Probe | null> {
  return page.evaluate(() => {
    const win = window as Window & {
      __opencode_e2e?: {
        model?: {
          current?: Probe
        }
      }
    }
    return win.__opencode_e2e?.model?.current ?? null
  })
}

async function state(page: Page) {
  const value = await probe(page)
  if (!value) throw new Error("Failed to resolve model selection probe")
  return value
}

const modelKey = (model?: { providerID: string; modelID: string } | null) =>
  model ? `${model.providerID}:${model.modelID}` : null

async function selectModel(page: Page, model: { providerID: string; modelID: string }) {
  const key = modelKey(model)
  await page.locator(`${promptModelSelector} [data-action="prompt-model"]`).first().click()

  const item = page.locator(`[data-slot="list-item"][data-key="${model.providerID}:${model.modelID}"]`).first()
  await expect(item).toBeVisible()
  await item.click({ force: true })

  await expect.poll(() => probe(page).then((value) => modelKey(value?.model)), { timeout: 10_000 }).toBe(key)
}

async function ready(page: Page) {
  const prompt = page.locator(promptSelector)
  await prompt.click()
  await expect(prompt).toBeFocused()
  await prompt.pressSequentially("focus")
  return prompt
}

async function body(prompt: Locator) {
  return prompt.evaluate((el) => (el as HTMLElement).innerText)
}

async function hitTest(locator: Locator) {
  return locator.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    const action = hit instanceof Element ? hit.closest("[data-action]")?.getAttribute("data-action") : null
    return {
      within: hit === el || !!hit && el.contains(hit),
      action,
      tag: hit?.tagName ?? null,
    }
  })
}

test("agent select returns focus to the prompt", async ({ page, project }) => {
  await project.open()
  const session = await project.sdk.session.create({ title: `e2e agent focus ${Date.now()}` }).then((r) => r.data)
  if (!session?.id) throw new Error("Session create did not return an id")
  project.trackSession(session.id)
  await project.gotoSession(session.id)

  const prompt = await ready(page)

  const info = await state(page)
  const next = info.agents?.map((item) => item.name).find((name) => name !== info.agent)
  test.skip(!next, "only one agent available")
  if (!next) return

  await page.locator(`${promptAgentSelector} [data-slot="select-select-trigger"]`).first().click()

  const item = page.locator('[data-slot="select-select-item"]').filter({ hasText: next }).first()
  await expect(item).toBeVisible()
  await item.click({ force: true })

  await expect(page.locator(`${promptAgentSelector} [data-slot="select-select-trigger-value"]`).first()).toHaveText(
    next,
  )
  await expect(prompt).toBeFocused()
  await prompt.pressSequentially(" agent")
  await expect.poll(() => body(prompt)).toContain("focus agent")
})

test("model select returns focus to the prompt", async ({ page, gotoSession }) => {
  await gotoSession()

  const prompt = await ready(page)

  const info = await state(page)
  const key = modelKey(info.model)
  const next = info.models?.find((item) => modelKey(item) !== key)
  test.skip(!next, "only one model available")
  if (!next) return

  await selectModel(page, next)
  await expect(page.locator(`${promptModelSelector} [data-action="prompt-model"] span`).first()).toHaveText(next.name)
  await expect(prompt).toBeFocused()
  await prompt.pressSequentially(" model")
  await expect.poll(() => body(prompt)).toContain("focus model")
})

test("home selected model is used for the first prompt", async ({ page, project }) => {
  await project.open()

  const info = await state(page)
  const key = modelKey(info.model)
  const next = info.models?.find((item) => modelKey(item) !== key)
  test.skip(!next, "only one model available")
  if (!next) return
  const nextKey = modelKey(next)

  await selectModel(page, next)

  const sessionID = await project.prompt(`home selected model ${Date.now()}`)
  await expect
    .poll(
      async () => {
        const messages = await project.sdk.session.messages({ sessionID, limit: 50 }).then((r) => r.data ?? [])
        return messages
          .filter((message) => message.info.role === "user")
          .some((message) => modelKey(message.info.model ?? null) === nextKey)
      },
      { timeout: 10_000 },
    )
    .toBe(true)
})

test("home model selector opens without footer overlap", async ({ page, gotoSession }) => {
  await gotoSession()

  const trigger = page.locator(`${promptModelSelector} [data-action="prompt-model"]`).first()
  await expect(trigger).toBeVisible()
  const hit = await hitTest(trigger)

  expect(hit.within, `model trigger center was intercepted by ${hit.tag ?? "unknown"} (${hit.action ?? "no-action"})`).toBe(
    true,
  )

  await trigger.click()

  await expect(page.locator('[data-slot="list-item"]').first()).toBeVisible()
})

test("home model selector closes when keyboard focus leaves", async ({ page, gotoSession }) => {
  await gotoSession()

  const trigger = page.locator(`${promptModelSelector} [data-action="prompt-model"]`).first()
  await trigger.click()

  const item = page.locator('[data-slot="list-item"]').first()
  await expect(item).toBeVisible()

  await page.keyboard.press("Shift+Tab")

  await expect(item).toBeHidden()
})
