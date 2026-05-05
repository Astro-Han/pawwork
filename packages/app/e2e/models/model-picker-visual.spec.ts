import { test, expect } from "../fixtures"
import { openPalette } from "../actions"
import { promptSelector } from "../selectors"
import type { Page } from "@playwright/test"

function rgb(value: string) {
  const [r, g, b] = value.match(/\d+/g)?.slice(0, 3).map(Number) ?? []
  if (r === undefined || g === undefined || b === undefined) throw new Error(`Invalid color: ${value}`)
  return [r, g, b] as const
}

function luminance([r, g, b]: readonly [number, number, number]) {
  const channel = (value: number) => {
    const normalized = value / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: readonly [number, number, number], b: readonly [number, number, number]) {
  const lighter = Math.max(luminance(a), luminance(b))
  const darker = Math.min(luminance(a), luminance(b))
  return (lighter + 0.05) / (darker + 0.05)
}

function cssColor(page: Page, variable: string) {
  return page.evaluate((name) => {
    const node = document.createElement("div")
    node.style.color = `var(${name})`
    document.body.appendChild(node)
    const color = getComputedStyle(node).color
    node.remove()
    return color
  }, variable)
}

test("model picker hover and tooltip stay visible", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.locator(promptSelector).click()
  await page.keyboard.type("/model")

  const command = page.locator('[data-slash-id="model.choose"]')
  await expect(command).toBeVisible()
  await command.hover()
  await page.keyboard.press("Enter")

  const picker = page.getByRole("dialog")
  await expect(picker).toBeVisible()
  const hoverSurface = await cssColor(page, "--surface-sunken")

  const row = picker.locator('[data-component="list-item"]').first()
  await expect(row).toBeVisible()

  const pickerBackground = await picker.evaluate((node) => getComputedStyle(node).backgroundColor)
  await row.hover()
  await expect(row).toHaveAttribute("data-active", "true")

  const rowBackground = await row.evaluate((node) => getComputedStyle(node).backgroundColor)
  expect(rowBackground).toBe(hoverSurface)
  expect(contrast(rgb(rowBackground), rgb(pickerBackground))).toBeGreaterThan(1.01)

  const tooltip = page.locator('[data-component="tooltip"]')
  await expect(tooltip).toBeVisible()

  const tooltipBackground = await tooltip.evaluate((node) => {
    const style = getComputedStyle(node)
    return style.backgroundColor
  })
  const textColors = await tooltip.locator("div").evaluateAll((nodes) => {
    return nodes
      .filter((node) => node.textContent?.trim())
      .map((node) => getComputedStyle(node).color)
  })
  expect(textColors.length).toBeGreaterThan(0)
  for (const textColor of textColors) {
    expect(contrast(rgb(tooltipBackground), rgb(textColor))).toBeGreaterThanOrEqual(4.5)
  }
})

test("prompt workspace and variant menus keep visible hover states", async ({ page, gotoSession }) => {
  await gotoSession()
  const hoverSurface = await cssColor(page, "--surface-sunken")

  const workspace = page.locator('[data-action="prompt-workspace"]')
  await expect(workspace).toBeVisible()
  await workspace.click()

  const workspaceMenu = page.getByRole("menu").filter({ hasText: /Workspace|工作区|项目/i })
  await expect(workspaceMenu).toBeVisible()
  const workspaceItem = workspaceMenu.locator('[role="menuitemradio"], [role="menuitem"]').first()
  await expect(workspaceItem).toBeVisible()

  const workspaceBackground = await workspaceMenu.evaluate((node) => getComputedStyle(node.parentElement ?? node).backgroundColor)
  await workspaceItem.hover()
  const workspaceItemBackground = await workspaceItem.evaluate((node) => getComputedStyle(node).backgroundColor)
  expect(workspaceItemBackground).toBe(hoverSurface)
  expect(contrast(rgb(workspaceItemBackground), rgb(workspaceBackground))).toBeGreaterThan(1.01)

  await page.keyboard.press("Escape")
  await expect(workspaceMenu).toHaveCount(0)

  const variant = page.locator('[data-action="prompt-model-variant"]')
  await expect(variant).toBeVisible()
  await variant.click()

  const variantMenu = page.getByRole("menu").filter({ hasText: /Reasoning effort|思考强度/i })
  await expect(variantMenu).toBeVisible()
  const variantItem = variantMenu.locator('[role="menuitemradio"]').first()
  await expect(variantItem).toBeVisible()

  const variantBackground = await variantMenu.evaluate((node) => getComputedStyle(node.parentElement ?? node).backgroundColor)
  await variantItem.hover()
  const variantItemBackground = await variantItem.evaluate((node) => getComputedStyle(node).backgroundColor)
  expect(variantItemBackground).toBe(hoverSurface)
  expect(contrast(rgb(variantItemBackground), rgb(variantBackground))).toBeGreaterThan(1.01)
})

test("command palette search results keep visible hover states", async ({ page, gotoSession }) => {
  await gotoSession()
  const hoverSurface = await cssColor(page, "--surface-sunken")

  const palette = await openPalette(page)
  await palette.getByRole("textbox").fill("open")

  const row = palette.locator('[data-component="list-item"]').first()
  await expect(row).toBeVisible()

  const paletteBackground = await palette.evaluate((node) => getComputedStyle(node).backgroundColor)
  await row.hover()
  await expect(row).toHaveAttribute("data-active", "true")

  const rowBackground = await row.evaluate((node) => getComputedStyle(node).backgroundColor)
  expect(rowBackground).toBe(hoverSurface)
  expect(contrast(rgb(rowBackground), rgb(paletteBackground))).toBeGreaterThan(1.01)
})
