import { test, expect } from "../fixtures"
import { modKey } from "../utils"

test("alt+mod+b toggles right panel", async ({ page, gotoSession }) => {
  await gotoSession()

  const rightPanel = page.locator("#right-panel")
  const initialHidden = await rightPanel.getAttribute("aria-hidden")
  const otherState = initialHidden === "true" ? "false" : "true"

  await page.keyboard.press(`Alt+${modKey}+b`)
  await expect(rightPanel).toHaveAttribute("aria-hidden", otherState)

  await page.keyboard.press(`Alt+${modKey}+b`)
  await expect(rightPanel).toHaveAttribute("aria-hidden", initialHidden!)
})
