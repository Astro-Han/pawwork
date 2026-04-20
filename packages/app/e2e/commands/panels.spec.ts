import { test, expect } from "../fixtures"
import { titlebarRightSelector } from "../selectors"
import { modKey } from "../utils"

test("desktop right-panel tabs switch between review and files within a unified utility shell", async ({ page, gotoSession }) => {
  await gotoSession()

  const rightToggle = page.locator(`${titlebarRightSelector} button`).first()
  const rightPanel = page.locator("#right-panel")
  await expect(rightToggle).toBeVisible()
  await expect(rightPanel).toHaveAttribute("aria-hidden", "true")

  await rightToggle.click()
  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")

  const shellTabList = rightPanel.getByRole("tablist").first()
  const reviewTab = shellTabList.getByRole("tab", { name: "Review", exact: true })
  const filesTab = shellTabList.getByRole("tab", { name: "Files", exact: true })
  await expect(shellTabList.getByRole("tab", { name: "Status", exact: true })).toBeVisible()
  await expect(filesTab).toBeVisible()
  await expect(reviewTab).toBeVisible()
  await expect(shellTabList.getByRole("tab", { name: "Terminal", exact: true })).toBeVisible()
  await expect(shellTabList.getByRole("tab", { name: "Status", exact: true })).toHaveAttribute("aria-selected", "true")

  await reviewTab.click()
  await expect(reviewTab).toHaveAttribute("aria-selected", "true")

  await filesTab.click()
  await expect(filesTab).toHaveAttribute("aria-selected", "true")

  await rightToggle.click()
  await expect(rightPanel).toHaveAttribute("aria-hidden", "true")

  await page.keyboard.press(`${modKey}+Shift+R`)
  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
  await expect(reviewTab).toHaveAttribute("aria-selected", "true")
})

test("desktop session keeps a single right-panel toggle and icon-first utility tabs", async ({ page, gotoSession }) => {
  await gotoSession()

  const rightChrome = page.locator(titlebarRightSelector)
  const rightPanel = page.locator("#right-panel")

  await expect(rightChrome.getByRole("button")).toHaveCount(1)
  await expect(rightChrome.getByRole("button", { name: /copy path/i })).toHaveCount(0)
  await expect(rightChrome.getByRole("button", { name: /toggle review/i })).toHaveCount(0)
  await expect(rightChrome.getByRole("button", { name: /toggle file tree/i })).toHaveCount(0)
  await expect(rightChrome.getByRole("button", { name: /toggle terminal/i })).toHaveCount(0)
  await expect(rightChrome.getByRole("button", { name: /status/i })).toHaveCount(0)

  await page.keyboard.press(`${modKey}+Shift+R`)
  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")

  const shellTabList = rightPanel.getByRole("tablist").first()
  await expect(shellTabList.locator('[data-component="icon"]')).toHaveCount(4)

  const widths = await shellTabList.locator('[data-slot="tabs-trigger"]').evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().width)),
  )

  expect(new Set(widths).size).toBe(1)
})

test("desktop right-panel shell tabs keep the sidepanel chrome contract", async ({ page, gotoSession }) => {
  await gotoSession()

  const rightPanel = page.locator("#right-panel")

  await page.keyboard.press(`${modKey}+Shift+R`)
  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")

  const shellTabList = rightPanel.getByRole("tablist").first()
  const statusWrapper = shellTabList.locator('[data-slot="tabs-trigger-wrapper"]').first()

  const wrapperStyles = await statusWrapper.evaluate((el) => {
    const style = window.getComputedStyle(el as HTMLElement)
    return {
      borderBottomWidth: style.borderBottomWidth,
      borderRightWidth: style.borderRightWidth,
      backgroundColor: style.backgroundColor,
    }
  })

  expect(wrapperStyles.borderBottomWidth).toBe("0px")
  expect(wrapperStyles.borderRightWidth).toBe("0px")
  expect(wrapperStyles.backgroundColor).toBe("rgba(0, 0, 0, 0)")
})

test("desktop session uses the design paneR icon for the right-panel toggle", async ({ page, gotoSession }) => {
  await gotoSession()

  const rightToggleIcon = page.locator(`${titlebarRightSelector} button [data-slot="icon-svg"]`).first()
  const iconMarkup = await rightToggleIcon.evaluate((el) => el.outerHTML)

  expect(iconMarkup).toContain('data-slot="icon-svg"')
  expect(iconMarkup).toContain('d="M8.5 2.5v9"')
})

test("desktop session uses the design paneL icon for the left sidebar toggle", async ({ page, gotoSession }) => {
  await gotoSession()

  const leftToggleIcon = page.getByRole("button", { name: /toggle sidebar/i }).locator('[data-slot="icon-svg"]').first()
  const iconMarkup = await leftToggleIcon.evaluate((el) => el.outerHTML)

  expect(iconMarkup).toContain('data-slot="icon-svg"')
  expect(iconMarkup).toContain('d="M5.5 2.5v9"')
  expect(iconMarkup).not.toContain("sidebar-active")
})

test("desktop right-panel uses the design icon set for utility tabs", async ({ page, gotoSession }) => {
  await gotoSession()

  const rightPanel = page.locator("#right-panel")

  await page.keyboard.press(`${modKey}+Shift+R`)
  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")

  const shellTabList = rightPanel.getByRole("tablist").first()
  const icons = await shellTabList.locator('[data-slot="tabs-trigger"] [data-slot="icon-svg"]').evaluateAll((els) =>
    els.map((el) => el.innerHTML),
  )

  expect(icons[0]).toContain('M2.5 3.5h8M2.5 6.5h8M2.5 9.5h5')
  expect(icons[1]).toContain('M1.5 3.5A1 1 0 012.5 2.5H5l1 1h3.5a1 1 0 011 1V9a1 1 0 01-1 1h-7a1 1 0 01-1-1V3.5z')
  expect(icons[2]).toContain('M2 6.5l2.5 2.5L11 3.5')
  expect(icons[3]).toContain('x="1.5" y="2.5" width="9" height="7"')
})

test("desktop review root shows a simple toolbar before opening files", async ({ page, gotoSession }) => {
  await gotoSession()

  const rightPanel = page.locator("#right-panel")
  await page.keyboard.press(`${modKey}+Shift+R`)
  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")

  const shellTabList = rightPanel.getByRole("tablist").first()
  const reviewTab = shellTabList.getByRole("tab", { name: "Review", exact: true })
  await reviewTab.click()
  await expect(reviewTab).toHaveAttribute("aria-selected", "true")

  await expect(rightPanel.getByRole("tablist")).toHaveCount(2)

  const openFile = rightPanel.getByRole("button", { name: /^Open file$/i }).first()
  await expect(openFile).toBeVisible()
})

test("desktop right-panel collapses shell tab labels below the compact threshold", async ({ page, gotoSession }) => {
  await gotoSession()

  const rightPanel = page.locator("#right-panel")

  await page.keyboard.press(`${modKey}+Shift+R`)
  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")

  const shellTabList = rightPanel.getByRole("tablist").first()
  const tabLabels = () =>
    shellTabList
      .locator('[data-slot="tabs-trigger"]')
      .evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ""))

  await expect.poll(tabLabels).toEqual(["", "", "", ""])

  await rightPanel.evaluate((el) => {
    ;(el as HTMLElement).style.width = "400px"
  })

  await expect.poll(tabLabels).toEqual(["Status", "Files", "Review", "Terminal"])

  await rightPanel.evaluate((el) => {
    ;(el as HTMLElement).style.width = "320px"
  })

  await expect.poll(tabLabels).toEqual(["", "", "", ""])
})

test("legacy changes side-panel state restores into the review tab", async ({ page, gotoSession, slug }) => {
  await page.addInitScript(({ slug }) => {
    const key = "opencode.global.dat:layout"
    const raw = localStorage.getItem(key)
    const parsed = (() => {
      if (!raw) return {}
      try {
        return JSON.parse(raw) as Record<string, unknown>
      } catch {
        return {}
      }
    })()

    const review =
      parsed.review && typeof parsed.review === "object"
        ? (parsed.review as Record<string, unknown>)
        : {}

    const sessionView =
      parsed.sessionView && typeof parsed.sessionView === "object"
        ? (parsed.sessionView as Record<string, unknown>)
        : {}

    const current =
      sessionView[slug] && typeof sessionView[slug] === "object"
        ? (sessionView[slug] as Record<string, unknown>)
        : {}

    localStorage.setItem(
      key,
      JSON.stringify({
        ...parsed,
        review: { ...review, panelOpened: true },
        sessionView: {
          ...sessionView,
          [slug]: {
            ...current,
            scroll: current.scroll && typeof current.scroll === "object" ? current.scroll : {},
            sidePanelTab: "changes",
          },
        },
      }),
    )
  }, { slug })

  await gotoSession()

  const rightPanel = page.locator("#right-panel")
  const shellTabList = rightPanel.getByRole("tablist").first()

  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
  await expect(shellTabList.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true")
})
