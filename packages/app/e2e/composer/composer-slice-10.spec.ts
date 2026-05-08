import { test, expect } from "../fixtures"

test.describe("composer slice 10 (L34)", () => {
  test("joined card wraps composer region as exactly one card", async ({ page, gotoSession }) => {
    await gotoSession()
    const cards = page.locator('[data-component="session-prompt-dock"] [data-dock="card"]')
    await expect(cards).toHaveCount(1)
  })

  test("send button is round 32 and exposes data-state", async ({ page, gotoSession }) => {
    await gotoSession()
    const send = page.locator('[data-action="prompt-submit"]').first()
    await expect(send).toBeVisible()
    await expect(send).toHaveAttribute("data-state", "idle")
    const box = await send.boundingBox()
    expect(box?.width).toBeCloseTo(32, 0)
    expect(box?.height).toBeCloseTo(32, 0)
  })

  test("model trigger opens a popover (not a dialog)", async ({ page, gotoSession }) => {
    await gotoSession()
    const trigger = page.locator('[data-action="prompt-model"]').first()
    await expect(trigger).toBeVisible()
    await trigger.click()
    await expect(page.locator('[role="dialog"]:has([data-slot="dialog-body"])')).toHaveCount(0)
    await expect(page.locator('[role="listbox"], [data-slot="list-scroll"]').first()).toBeVisible()
  })
})
