import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"
import { closeSettingsPanel, openSettings } from "../actions"

test("fetches models for Kimi even though inference uses the Anthropic adapter", async ({ page, project }) => {
  await project.open({
    beforeGoto: async ({ sdk }) => {
      await sdk.auth.set({
        providerID: "kimi-for-coding",
        auth: { type: "api", key: "e2e-kimi-key" },
      })
    },
  })
  await page.route(/\/provider\/kimi-for-coding\/models(?:\?|$)/, async (route) => {
    expect(route.request().method()).toBe("POST")
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ models: [{ id: "kimi-e2e-live", name: "Kimi E2E Live" }] }),
    })
  })

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Models" }).click()

  const heading = settings.getByText("Kimi For Coding", { exact: true }).last()
  await expect(heading).toBeVisible()
  const beforeFetch = page.url()
  await heading.locator("..").getByRole("button", { name: "Fetch models" }).click()

  await expect(settings.getByRole("switch", { name: "Kimi E2E Live" })).not.toBeChecked()
  await expect(page).toHaveURL(beforeFetch)
})

test("hiding a model removes it from the model picker", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.locator(promptSelector).click()
  await page.keyboard.type("/model")

  const command = page.locator('[data-slash-id="model.choose"]')
  await expect(command).toBeVisible()
  await command.hover()
  await page.keyboard.press("Enter")

  const picker = page.getByRole("dialog")
  await expect(picker).toBeVisible()

  const target = picker.locator('[data-slot="list-item"]').first()
  await expect(target).toBeVisible()

  const key = await target.getAttribute("data-key")
  if (!key) throw new Error("Failed to resolve model key from list item")

  const name = (await target.locator("span").first().innerText()).trim()
  if (!name) throw new Error("Failed to resolve model name from list item")

  await page.keyboard.press("Escape")
  await expect(picker).toHaveCount(0)

  const settings = await openSettings(page)

  await settings.getByRole("tab", { name: "Models" }).click()
  const search = settings.getByPlaceholder("Search models")
  await expect(search).toBeVisible()
  await search.fill(name)

  const toggle = settings.locator('[data-component="switch"]').filter({ hasText: name }).first()
  const input = toggle.locator('[data-slot="switch-input"]')
  await expect(toggle).toBeVisible()
  await expect(input).toHaveAttribute("aria-checked", "true")
  await toggle.locator('[data-slot="switch-control"]').click()
  await expect(input).toHaveAttribute("aria-checked", "false")

  await closeSettingsPanel(page, settings)

  await page.locator(promptSelector).click()
  await page.keyboard.type("/model")
  await expect(command).toBeVisible()
  await command.hover()
  await page.keyboard.press("Enter")

  const pickerAgain = page.getByRole("dialog")
  await expect(pickerAgain).toBeVisible()
  await expect(pickerAgain.locator('[data-slot="list-item"]').first()).toBeVisible()

  await expect(pickerAgain.locator(`[data-slot="list-item"][data-key="${key}"]`)).toHaveCount(0)

  await page.keyboard.press("Escape")
  await expect(pickerAgain).toHaveCount(0)
})

test("showing a hidden model restores it to the model picker", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.locator(promptSelector).click()
  await page.keyboard.type("/model")

  const command = page.locator('[data-slash-id="model.choose"]')
  await expect(command).toBeVisible()
  await command.hover()
  await page.keyboard.press("Enter")

  const picker = page.getByRole("dialog")
  await expect(picker).toBeVisible()

  const target = picker.locator('[data-slot="list-item"]').first()
  await expect(target).toBeVisible()

  const key = await target.getAttribute("data-key")
  if (!key) throw new Error("Failed to resolve model key from list item")

  const name = (await target.locator("span").first().innerText()).trim()
  if (!name) throw new Error("Failed to resolve model name from list item")

  await page.keyboard.press("Escape")
  await expect(picker).toHaveCount(0)

  const settings = await openSettings(page)

  await settings.getByRole("tab", { name: "Models" }).click()
  const search = settings.getByPlaceholder("Search models")
  await expect(search).toBeVisible()
  await search.fill(name)

  const toggle = settings.locator('[data-component="switch"]').filter({ hasText: name }).first()
  const input = toggle.locator('[data-slot="switch-input"]')
  await expect(toggle).toBeVisible()
  await expect(input).toHaveAttribute("aria-checked", "true")

  await toggle.locator('[data-slot="switch-control"]').click()
  await expect(input).toHaveAttribute("aria-checked", "false")

  await toggle.locator('[data-slot="switch-control"]').click()
  await expect(input).toHaveAttribute("aria-checked", "true")

  await closeSettingsPanel(page, settings)

  await page.locator(promptSelector).click()
  await page.keyboard.type("/model")
  await expect(command).toBeVisible()
  await command.hover()
  await page.keyboard.press("Enter")

  const pickerAgain = page.getByRole("dialog")
  await expect(pickerAgain).toBeVisible()

  await expect(pickerAgain.locator(`[data-slot="list-item"][data-key="${key}"]`)).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(pickerAgain).toHaveCount(0)
})
