import { test, expect } from "../fixtures"
import { rightPanelTabList } from "../actions"
import { titlebarRightSelector } from "../selectors"

test("desktop right-panel toggle opens the status tab by default", async ({ page, gotoSession }) => {
  await gotoSession()

  const rightToggle = page.locator(`${titlebarRightSelector} button`).first()
  const rightPanel = page.locator("#right-panel")
  const shellTabList = rightPanelTabList(page)

  await expect(rightPanel).toHaveAttribute("aria-hidden", "true")

  await rightToggle.click()

  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
  await expect(shellTabList.getByRole("tab", { name: "Status", exact: true })).toHaveAttribute("aria-selected", "true")
  // Servers / MCP / LSP / Plugins live in Settings.Integrations now; the right-panel
  // Status tab only carries Summary. Mobile popover still has the tabs (see test below).
})

test("desktop right-panel toggle closes the right panel", async ({ page, gotoSession }) => {
  await gotoSession()

  const rightToggle = page.locator(`${titlebarRightSelector} button`).first()
  const rightPanel = page.locator("#right-panel")

  await rightToggle.click()
  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")

  await rightToggle.click()
  await expect(rightPanel).toHaveAttribute("aria-hidden", "true")
})

test("mobile session status button still opens the status popover", async ({ page, gotoSession }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoSession()

  const statusButton = page.locator('[data-action="pawwork-status-popover-toggle"]')
  const popoverBody = page.locator('[data-slot="popover-body"]').filter({ has: page.locator('[data-component="tabs"]') })

  await statusButton.click()
  await expect(statusButton).toHaveAttribute("aria-expanded", "true")
  await expect(popoverBody).toBeVisible()
  await expect(popoverBody.getByRole("tab", { name: /servers/i })).toBeVisible()
  await page.mouse.move(10, 500, { steps: 5 })

  const expandedStyles = () =>
    statusButton.evaluate((el) => {
      const icon = el.querySelector<HTMLElement>('[data-slot="icon-svg"]')
      const style = getComputedStyle(el)
      const probe = document.createElement("div")
      probe.style.backgroundColor = style.getPropertyValue("--surface-base")
      probe.style.color = style.getPropertyValue("--icon-strong")
      document.body.appendChild(probe)
      const expected = {
        background: getComputedStyle(probe).backgroundColor,
        iconColor: getComputedStyle(probe).color,
      }
      probe.remove()
      return {
        expected,
        actual: {
          background: style.backgroundColor,
          iconColor: icon ? getComputedStyle(icon).color : null,
        },
      }
    })
  const expectedStyles = (await expandedStyles()).expected
  await expect.poll(async () => (await expandedStyles()).actual).toEqual(expectedStyles)
})
