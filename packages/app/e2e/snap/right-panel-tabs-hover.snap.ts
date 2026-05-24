import { expect, type Page } from "@playwright/test"
import { openRightPanel, openSidebar } from "../actions"
import { test } from "../fixtures"
import { sessionItemSelector } from "../selectors"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

// Hover-state probe for the right-panel tab strip. Captures three states of
// the closable Files tab so we can verify the close-button affordance:
//
//   1) rest        — Files tab at rest, leading icon only, no close button
//   2) hover       — mouse hovering Files tab; expectation: leading icon
//                    fades to opacity 0, close × fades in at the same 14×14
//                    cell, no layout shift, no double-icon visible
//   3) measurements — page-level dump of bounding boxes for the close-button
//                    slot vs leading icon vs label so we know exactly where
//                    each piece lands in screen coordinates.
//
// Why not extend right-panel-titlebar.snap.ts: that snap intentionally moves
// the mouse to (0,0) to freeze a clean static frame. Hover state needs its
// own target so the two contracts don't fight.

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce" })

async function openFilesAndReview(page: Page) {
  await page.locator("main").first().click()
  await page.keyboard.press("ControlOrMeta+\\")
  await page.keyboard.press("ControlOrMeta+Shift+R")
  await expect.poll(() => page.getByRole("tab").count(), { timeout: 5_000 }).toBe(3)
  await page.getByRole("tab", { name: "Status" }).click()
}

async function dumpBoxes(page: Page, label: string) {
  // Dump the bounding boxes of every interesting element in the tab strip so
  // we can reason about exact positions vs the CSS-declared 14×14 + left:10
  // contract in tabs.css.
  const data = await page.evaluate(() => {
    const tabs = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger-wrapper"]'),
    )
    return tabs.map((wrap) => {
      const trig = wrap.querySelector<HTMLElement>('[data-slot="tabs-trigger"]')
      const icon = wrap.querySelector<HTMLElement>('[data-slot="tab-icon-default"]')
      const iconSvg = icon?.querySelector<HTMLElement>('[data-component="icon"]')
      const closeSlot = wrap.querySelector<HTMLElement>('[data-slot="tabs-trigger-close-button"]')
      const closeBtn = closeSlot?.querySelector<HTMLElement>('[data-component="icon-button"]')
      const closeBtnIcon = closeBtn?.querySelector<HTMLElement>('[data-component="icon"]')
      const cs = (el?: HTMLElement | null) => (el ? window.getComputedStyle(el) : null)
      const box = (el?: HTMLElement | null) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      }
      return {
        value: wrap.getAttribute("data-value"),
        selected: trig?.getAttribute("data-selected") === "" || trig?.hasAttribute("data-selected"),
        wrapper: box(wrap),
        trigger: box(trig),
        leadingSpan: box(icon),
        leadingIconDiv: box(iconSvg),
        closeSlot: box(closeSlot),
        closeBtn: box(closeBtn),
        closeBtnIcon: box(closeBtnIcon),
        closeSlotOpacity: cs(closeSlot)?.opacity,
        leadingSpanOpacity: cs(icon)?.opacity,
        triggerFontWeight: cs(trig)?.fontWeight,
      }
    })
  })
  process.stdout.write(`\n[boxes ${label}]\n${JSON.stringify(data, null, 2)}\n`)
}

async function captureStates(
  page: Page,
  label: "light" | "dark",
  sessionID: string,
): Promise<Shot[]> {
  await openSidebar(page)
  await page.locator(sessionItemSelector(sessionID)).click()
  await openRightPanel(page)
  await openFilesAndReview(page)

  // Rest state — mouse parked far away so no tab hovers.
  await page.mouse.move(0, 0)
  await page.waitForTimeout(200)
  await dumpBoxes(page, `${label}-rest`)
  const rest = {
    name: `${label}-rest`,
    buf: await page.screenshot({
      clip: { x: 600, y: 0, width: 700, height: 80 },
      animations: "disabled",
    }),
  }

  // Hover state — hover the Files tab (closable). This should fade the
  // leading icon and reveal the × close button.
  await page.getByRole("tab", { name: "Files" }).hover()
  await page.waitForTimeout(200)
  await dumpBoxes(page, `${label}-hover-files`)
  const hoverFiles = {
    name: `${label}-hover-files`,
    buf: await page.screenshot({
      clip: { x: 600, y: 0, width: 700, height: 80 },
      animations: "disabled",
    }),
  }

  // Hover state on Review (also closable) — Review is selected by default
  // after openFilesAndReview clicks Status? No, openFilesAndReview clicks
  // Status; Review/Files are open but unselected. So this is hover on an
  // unselected closable tab — same expected swap.
  await page.getByRole("tab", { name: "Review" }).hover()
  await page.waitForTimeout(200)
  await dumpBoxes(page, `${label}-hover-review`)
  const hoverReview = {
    name: `${label}-hover-review`,
    buf: await page.screenshot({
      clip: { x: 600, y: 0, width: 700, height: 80 },
      animations: "disabled",
    }),
  }

  return [rest, hoverFiles, hoverReview]
}

test("right-panel-tabs-hover", async ({ page, project }) => {
  test.setTimeout(180_000)

  let sessionID: string | undefined
  await project.open({
    beforeGoto: async ({ sdk }) => {
      const session = await sdk.session.create({ title: "snap right panel tabs hover" }).then((res) => res.data)
      sessionID = session?.id
    },
  })
  if (!sessionID) throw new Error("Session create did not return an id")
  project.trackSession(sessionID)

  const shots: Shot[] = []
  shots.push(...(await captureStates(page, "light", sessionID)))
  await applyDarkModeForTests(page)
  shots.push(...(await captureStates(page, "dark", sessionID)))

  const out = snapOutputPath("right-panel-tabs-hover")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] right-panel-tabs-hover grid -> ${out}\n\n`)
})
