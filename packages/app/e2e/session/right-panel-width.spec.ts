import { test, expect } from "../fixtures"
import { sessionTurnListSelector, titlebarRightSelector } from "../selectors"
import { withSession } from "../actions"

test("right panel keeps its tab body through the close transition before unmounting it", async ({
  page,
  gotoSession,
}) => {
  await gotoSession()

  const rightToggle = page.locator(`${titlebarRightSelector} button`).first()
  const aside = page.getByRole("complementary", { name: "Right utility panel", includeHidden: true })
  const body = aside.locator('[data-component="right-panel-body"]')
  const tabLists = aside.locator('[role="tablist"]')
  const asideWidth = () => aside.evaluate((el) => Math.round(el.getBoundingClientRect().width))
  const initiallyOpen = (await aside.getAttribute("aria-hidden")) === "false"
  if (initiallyOpen) await rightToggle.click()

  await expect(aside).toHaveAttribute("aria-hidden", "true")
  await expect(body).toHaveCount(0)

  await rightToggle.click()
  await expect(aside).toHaveAttribute("aria-hidden", "false")
  await expect(body).toHaveCount(1)
  await expect(tabLists.first()).toBeVisible()

  await rightToggle.click()
  await expect(aside).toHaveAttribute("aria-hidden", "true")
  await expect(body).toHaveCount(1)

  await page.waitForTimeout(300)
  await expect(body).toHaveCount(0)
  await expect.poll(asideWidth).toBe(0)
})

test("right panel width persists across reload", async ({ page, gotoSession }) => {
  await gotoSession()

  // Open the right panel via the titlebar toggle (matches e2e/commands/panels.spec.ts).
  const rightToggle = page.locator(`${titlebarRightSelector} button`).first()
  const aside = page.getByRole("complementary", { name: "Right utility panel", includeHidden: true })
  const hiddenBefore = (await aside.getAttribute("aria-hidden")) === "true"
  if (hiddenBefore) await rightToggle.click()
  await expect(aside).toHaveAttribute("aria-hidden", "false")

  // Drive the resize through the exposed layout hook (see packages/app/src/context/layout.tsx DEV block).
  await page.evaluate(() => {
    const layout = (window as unknown as { __pawworkLayout?: { rightPanel?: { resize?: (w: number) => void } } })
      .__pawworkLayout
    if (!layout?.rightPanel?.resize) {
      throw new Error("__pawworkLayout.rightPanel.resize is not exposed; check layout.tsx DEV hook")
    }
    layout.rightPanel.resize(400)
  })

  const widthBefore = await aside.evaluate((el) => (el as HTMLElement).style.width)
  expect(widthBefore).toBe("400px")

  // Reload; persisted() should restore 400 on mount.
  await page.reload()
  await gotoSession()

  const aside2 = page.getByRole("complementary", { name: "Right utility panel", includeHidden: true })
  const toggle2 = page.locator(`${titlebarRightSelector} button`).first()
  const hiddenAfter = (await aside2.getAttribute("aria-hidden")) === "true"
  if (hiddenAfter) await toggle2.click()
  await expect(aside2).toHaveAttribute("aria-hidden", "false")

  const widthAfter = await aside2.evaluate((el) => (el as HTMLElement).style.width)
  expect(widthAfter).toBe("400px")
})

test("session chat column stays capped when right panel opens", async ({ page, sdk, gotoSession }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })

  await withSession(sdk, `e2e panel layout ${Date.now()}`, async (session) => {
    await gotoSession(session.id)

    const rightToggle = page.locator(`${titlebarRightSelector} button`).first()
    const aside = page.getByRole("complementary", { name: "Right utility panel", includeHidden: true })
    const initiallyOpen = (await aside.getAttribute("aria-hidden")) === "false"
    if (initiallyOpen) {
      await rightToggle.click()
      await expect(aside).toHaveAttribute("aria-hidden", "true")
    }

    const turnList = page.locator(sessionTurnListSelector)
    await expect(turnList).toBeVisible()
    const turnListWidth = () => turnList.evaluate((el) => Math.round(el.getBoundingClientRect().width))

    const widthBefore = await turnListWidth()
    expect(widthBefore).toBe(1000)

    await rightToggle.click()

    await expect(aside).toHaveAttribute("aria-hidden", "false")

    await expect.poll(turnListWidth).toBe(widthBefore)

    await rightToggle.click()
    await expect(aside).toHaveAttribute("aria-hidden", "true")

    await page.setViewportSize({ width: 1100, height: 1000 })
    await expect.poll(turnListWidth).toBe(800)

    await rightToggle.click()
    await expect(aside).toHaveAttribute("aria-hidden", "false")
    await expect.poll(turnListWidth).toBeLessThan(800)
  })
})
